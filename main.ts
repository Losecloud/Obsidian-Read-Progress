/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Access Obsidian internal fields (view.editor.cm, app.internalPlugins, leaf.view) and parse data.json; no public API exists */
import {
	App,
	MarkdownView,
	MenuItem,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	debounce,
	TFile,
} from 'obsidian';

/** 设置项类型 */
interface ExplorerReadingProgressSettings {
	/** 进度条宽度（px） */
	barWidth: number;
	/** 进度条线宽（px，即高度/粗细） */
	lineWidth: number;
	/** 进度条垂直下移距离（px），正值向下偏移 */
	barOffset: number;
	/** 进度条两端圆角（全圆角），默认直角 */
	rounded: boolean;
	/** 进行中填充色（空 = 系统主题色自适应） */
	pendingColor: string;
	/** 完成填充色（空 = 绿色） */
	completeColor: string;
	/** Beta：启用覆盖模型（记录真实阅读区域，分段渲染）。默认关闭 = 当前位置模式 */
	beta: boolean;
	/** Beta：阅读目标时长（分钟）。区域阅读时长达到该值时显示达成色，浓度按 0~目标自动适配 */
	readGoal: number;
	/** Beta：系统滚动渲染（beta 模式下可用）。把当前笔记的阅读浓度渲染到
	 *  正文视图右侧滚动条所在的背景条内，直观看到已读/未读部分 */
	systemScrollRendering: boolean;
	/** Beta：系统滚动渲染浓度不透明度（0~1，在浓度基础上乘算） */
	sysScrollOpacity: number;
	/** Beta：系统滚动渲染线宽（px）。超过滚动条最大宽度时按完整填满背景条 */
	sysScrollLineWidth: number;
	/** Beta：系统滚动渲染位置（left = 背景条左侧开始染色，right = 右侧） */
	sysScrollPosition: 'left' | 'right';
	/** Beta：Show Content。悬浮笔记左侧 cm-scroller padding 区域时，
	 *  从左侧动画浮现目录侧边栏（结构化笔记内容，点击跳转） */
	showContent: boolean;
	/** 记住 md 笔记上次阅读位置，再次打开时恢复（类似 PDF 内置行为） */
	restoreMdPosition: boolean;
	/** 信息显示类型（文件树条目右侧，data 属性 + CSS 伪元素渲染）
	 *  1st/2nd/3rd 三个槽位，互斥（选了 A 则其他槽位排除 A） */
	infoDisplay1: InfoType;
	infoDisplay2: InfoType;
	infoDisplay3: InfoType;
}

/** 信息显示类型（none = 不显示） */
type InfoType =
	| 'none'
	| 'readtime'
	| 'esttime'
	| 'lastread'
	| 'progress';

const DEFAULT_SETTINGS: ExplorerReadingProgressSettings = {
	barWidth: 100,
	lineWidth: 2,
	barOffset: 3,
	rounded: true,
	pendingColor: '',
	completeColor: '',
	beta: true,
	readGoal: 5,
	systemScrollRendering: false,
	sysScrollOpacity: 1,
	sysScrollLineWidth: 4,
	sysScrollPosition: 'left',
	showContent: false,
	restoreMdPosition: false,
	infoDisplay1: 'readtime',
	infoDisplay2: 'none',
	infoDisplay3: 'none',
};

/**
 * Debug 模式：代码内部开关（跟随程序打包，不暴露给用户）。
 * 开启后 console 输出计时调试信息（进行中/暂停/原因）。
 * 需要调试时由开发者改为 true 后重新构建。
 */
const DEBUG_MODE = false;

/** 阅读计时：最小停留（秒），低于此值视为快速乱翻，不计入时长 */
const MIN_DWELL_SECONDS = 3;
/** 阅读计时：单区域停留封顶（秒），挂机亮屏停在同一页不再累加 */
const MAX_DWELL_SECONDS = 300;
/** 阅读计时：心跳间隔（ms） */
const READ_TIMER_TICK_MS = 1000;

/** 覆盖模型分辨率：进度条按固定桶数采样，所有笔记粒度一致 */
const BUCKET_COUNT = 200;

/** 单个笔记的阅读进度（桶模型：散点叠加式） */
interface NoteProgress {
	/** 文档总高度（px），滚动时更新 */
	total: number;
	/** 每个桶的累计阅读秒数（固定 BUCKET_COUNT 个，散点叠加） */
	buckets: number[];
	/** 累计阅读总秒数（总计时器：独立总计时，仅用于 info display 的 read time） */
	readSeconds: number;
}

/** 初始化空桶 */
function createBuckets(): number[] {
	return new Array(BUCKET_COUNT).fill(0);
}

/** #rrggbb → rgba(r, g, b, a)（渐变颜色停需要 rgba 形式） */
function hexToRgba(hex: string, alpha: number): string {
	const m = hex.match(/^#?([0-9a-f]{6})$/i);
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * 向桶模型写入阅读时长（同一区域取峰值，不累加）。
 * 视口覆盖的桶写入秒数：来回滚动到同一区域时
 * 重复结算会重复累加，取峰值确保同一区域的阅读
 * 时长不重复计算（散点叠加式渐进染色）。
 */
function addToBuckets(
	buckets: number[],
	total: number,
	start: number,
	end: number,
	seconds: number
): void {
	if (seconds <= 0 || end <= start || total <= 0) return;
	// 全额计入：桶模型的平滑渐变由 bucketsToRanges 合并相近桶实现，
	// 无需 step 衰减（衰减会让浓度永远追不上目标时长，导致不变绿）
	const ratio = BUCKET_COUNT / total;
	const i0 = Math.max(0, Math.floor(start * ratio));
	const i1 = Math.min(BUCKET_COUNT - 1, Math.floor(end * ratio));
	for (let i = i0; i <= i1; i++) {
		// 同一区域取峰值：来回滚动重复结算不重复累加
		buckets[i] = Math.max(buckets[i], seconds);
	}
}

/**
 * 从桶生成渲染区间：相邻且浓度相近的桶合并为一段。
 * 连续阅读区域 → 相邻桶浓度相近 → 合并为一段，无割裂断点。
 */
function bucketsToRanges(
	buckets: number[],
	total: number
): Array<[number, number, number]> {
	const ranges: Array<[number, number, number]> = [];
	const px = total / BUCKET_COUNT;
	let i = 0;
	while (i < BUCKET_COUNT) {
		const secs = buckets[i];
		if (secs <= 0) {
			i++;
			continue;
		}
		// 合并相邻且浓度相近的桶（浓度差 ≤ 30% 或 ≤ 5s）
		let j = i + 1;
		while (
			j < BUCKET_COUNT &&
			buckets[j] > 0 &&
			Math.abs(buckets[j] - secs) <= Math.max(secs * 0.3, 5)
		) {
			j++;
		}
		// 段浓度取区间内峰值（散点叠加的最高浓度）
		let peak = secs;
		for (let k = i; k < j; k++) peak = Math.max(peak, buckets[k]);
		ranges.push([i * px, j * px, peak]);
		i = j;
	}
	return ranges;
}

/** 旧版区间数据迁移：ranges → 桶（覆盖位置按峰值写入） */
function rangesToBuckets(
	ranges: Array<[number, number, number]>,
	total: number
): number[] {
	const buckets = createBuckets();
	if (total <= 0) return buckets;
	const ratio = BUCKET_COUNT / total;
	for (const [s, e, secs] of ranges) {
		const i0 = Math.max(0, Math.floor(s * ratio));
		const i1 = Math.min(BUCKET_COUNT - 1, Math.floor(e * ratio));
		for (let i = i0; i <= i1; i++) {
			buckets[i] = Math.max(buckets[i], secs);
		}
	}
	return buckets;
}

/**
 * 文件资源管理器条目内部结构（官方未公开类型声明，按需定义最小形状）。
 * 与社区插件 Files Progress 依赖的字段一致。
 */
interface FileExplorerItem {
	selfEl?: HTMLElement;
	titleEl?: HTMLElement;
}

interface FileExplorerView {
	fileItems?: Record<string, FileExplorerItem>;
	containerEl?: HTMLElement;
}

/**
 * 编辑/阅读子视图的滚动信息（官方 EditorScrollInfo）。
 * top：滚动偏移；height：内容总高度；clientHeight：可视区高度。
 */
interface ScrollInfo {
	top: number;
	height: number;
	clientHeight: number;
}

/** Obsidian 内部 PDF 视图的 pdf.js 查看器（ObsidianViewer，未公开字段） */
interface ObsidianPdfViewerLike {
	/** 当前页索引（0-based） */
	page: number;
	/** 总页数（异步加载，打开初期为 0） */
	pagesCount: number;
	/** pdf.js 事件总线（pagechanging：翻页按钮/目录跳转，单页模式不触发滚动） */
	eventBus?: {
		on: (name: string, cb: (e: unknown) => void) => void;
		off: (name: string, cb: (e: unknown) => void) => void;
	};
	/** DOM 结构（viewerContainerEl 为滚动容器，连续模式可滚动） */
	dom?: { viewerContainerEl?: HTMLElement } | null;
}

/** PDFViewerChild：viewer 与 pdf.js 查看器之间的桥接层（异步就绪） */
interface PdfViewerChildLike {
	pdfViewer?: ObsidianPdfViewerLike;
	/** 当前加载的 PDF 文件 */
	file?: TFile;
	/** child 就绪后执行回调（先于 then 注册的回调可能丢失，用轮询兜底） */
	then?: (cb: (child: PdfViewerChildLike) => void) => void;
}

/** PDFViewerComponent：PDFView.viewer（未公开字段） */
interface PdfViewerComponentLike {
	/** 桥接层，加载文件后异步创建 */
	child?: PdfViewerChildLike | null;
	then?: (cb: (child: PdfViewerChildLike) => void) => void;
}

/** Obsidian 内部 PDF 视图（未公开类）的最小结构 */
interface PdfViewLike {
	file?: TFile;
	viewer?: PdfViewerComponentLike;
}

/** Excalidraw 绘图视图（第三方插件，未公开类）的最小结构 */
interface ExcalidrawViewLike {
	file?: TFile;
	containerEl?: HTMLElement;
	getViewType?: () => string;
}

export default class ReadProgressPlugin extends Plugin {
	settings: ExplorerReadingProgressSettings = DEFAULT_SETTINGS;

	/** 滚动事件防抖（300ms） */
	private debouncedSave: ReturnType<typeof debounce>;
	/** 阅读进度落盘防抖（2s）：合并滚动/结算写盘，降低 Sync churn */
	private persistProgress: ReturnType<typeof debounce>;
	/** 文件树全量刷新防抖（150ms） */
	private scheduleRefresh: ReturnType<typeof debounce>;
	/** 文件树单条目定向刷新防抖（150ms） */
	private schedulePathRefresh: ReturnType<typeof debounce>;
	/** 上一次写入的进度，用于跳过无变化的写入 */
	private lastWritten: Map<string, string> = new Map();
	/** 当前滚动监听的绑定信息，用于卸载时移除 */
	private scrollBinding: {
		target: HTMLElement;
		listener: (e?: Event) => void;
		path: string;
		/** 捕获阶段监听（md 挂在 leaf 容器上，需按捕获解绑） */
		capture?: boolean;
		/** md 视图真正的滚动元素（读取阅读位置用） */
		scroller?: HTMLElement;
		/** PDF 视图的 pdf.js 事件总线（解绑 pagechanging） */
		eventBus?: { off: (name: string, cb: (e: unknown) => void) => void };
	} | null = null;
	/** 进度数据：路径 → 覆盖模型（统一存于 data.json） */
	private progressData: Record<string, NoteProgress> = {};
	/** md 笔记上次阅读位置（px，滚动停止后记录，用于再次打开时恢复） */
	private mdPositions: Record<string, number> = {};
	/** 系统滚动渲染：当前渲染的滚动容器，切走/关闭时清理 */
	private sysScrollEl: HTMLElement | null = null;
	private sysScrollPath: string | null = null;
	private sysScrollListener: (() => void) | null = null;
	/** 系统滚动渲染：系统滚动条宽度（px，用于线宽填满判定） */
	private sysScrollbarWidth: number = 0;
	/** 系统滚动渲染：更新防抖（滚动停止后 150ms 渲染一次） */
	private scheduleSysScrollRender: ReturnType<typeof debounce>;
	/** 阅读计时状态：当前停留区域（微信读书式计时，翻页/切页时结算） */
	private readTimer: {
		path: string;
		start: number;
		end: number;
		total: number;
		credited: number;
		/** 位置单位：md 按像素，pdf 按页 */
		unit: 'px' | 'page';
	} | null = null;
	/** 最后一次键鼠操作时间戳（防 idle：5min 无操作才封顶） */
	private lastInputTs: number = Date.now();
	/** Obsidian 窗口焦点状态（window blur/focus 事件维护，
	 *  比 document.hasFocus() 可靠） */
	private windowFocused: boolean = true;
	/** 失焦开始时间戳（blur 事件丢失时兜底：持续失焦超时结算） */
	private blurStartTs: number | null = null;
	/** 社区插件页滚动位置（Back 按钮返回时恢复，避免回到列表顶部） */
	private communityScrollTop = 0;
	/** 设置页 DOM 监测器（社区插件列表出现时附加滚动监听） */
	private settingObserver: MutationObserver | null = null;
	/** NWC 属性监测器（data-novel-word-count-plugin 变化时同步刷新 RP 信息） */
	private nwcObserver: MutationObserver | null = null;
	/** 文件树 DOM 监测器（文件夹展开时即时装饰新进入的文件节点） */
	private explorerObserver: MutationObserver | null = null;

	constructor(app: App, manifest: PluginManifestLike) {
		super(app, manifest);
		// 300ms 防抖：滚动停止后才写入数据文件
	this.debouncedSave = debounce(
		(file: TFile, top: number, vh: number, total: number, unit: 'px' | 'page') => {
			void this.writeProgress(file, top, vh, total, unit);
		},
		300,
		true
	);
		// 150ms 防抖：合并文件树刷新，避免高频重渲染
		this.scheduleRefresh = debounce(() => this.refreshAll(), 150, true);
		this.schedulePathRefresh = debounce((path: string) => this.decoratePath(path), 150, true);
		// 2s 防抖：合并阅读进度的磁盘写入（滚动停止 + 计时结算共用）。
		// 进度数据已在内存（this.progressData）中即时更新，延迟落盘不影响
		// 界面；大幅降低连续滚动时的写盘频率（Obsidian Sync 场景明显减 churn）
		this.persistProgress = debounce(() => {
			void this.saveSettings();
		}, 2000, true);
		// 150ms 防抖：滚动停止后渲染系统滚动条浓度
		this.scheduleSysScrollRender = debounce(() => this.renderSystemScrollTrack(), 150, true);
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ExplorerReadingProgressSettingTab(this.app, this));
		// 应用进度条尺寸与偏移（body 级 CSS 变量）
		this.applyBarStyle();
		// 清理旧版本残留的装饰 DOM（如旧版 <progress> 元素），避免粗细不一
		this.cleanupDecorations();

		// 激活文档变化：停止旧文档监听，改挂新文档（防止内存泄漏）
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.attachScrollListener();
				// 系统滚动渲染：切走时移除旧渲染，切入新视图时挂载
				this.detachSystemScrollTrack();
				this.attachSystemScrollTrack();
			})
		);
		// 阅读视图切换（编辑 ↔ 阅读模式，内容页右上角 view-actions 按钮）：
		// 模式切换不触发 active-leaf-change（仍是同一 leaf），
		// 旧滚动监听挂在已卸载的容器上，导致阅读视图下
		// 不记录阅读浓度、滚动条背景无浓度渲染。
		// 点击 view-action 后视图结构重建，延迟重挂。
		this.registerDomEvent(
			window,
			'click',
			(e: MouseEvent) => {
				const el = e.target;
				if (!(el instanceof HTMLElement)) return;
				if (!el.closest('.view-actions .view-action')) return;
				window.setTimeout(() => {
					const view =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					// 清除写入指纹：确保模式切换后立即采集一次
					if (view?.file) this.lastWritten.delete(view.file.path);
					this.attachScrollListener();
					this.detachSystemScrollTrack();
					this.attachSystemScrollTrack();
				}, 150);
			},
			true
		);

		// frontmatter 变化 → 定向刷新对应条目（Files Progress 同款机制）
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.schedulePathRefresh(file.path);
					// Show Content：笔记内容变化时重解析目录
					this.invalidateContentCache(file.path);
				}
			})
		);
		// 删除/重命名 → 全量重建
		this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh()));

		// 布局变化（折叠/展开文件夹、切换仓库视图、新建拆分窗口）→ 全量刷新
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.scheduleRefresh();
				// NWC 在 layout-change 后防抖更新显示属性，
				// 延迟刷新确保读到最新值（启用/禁用 NWC 时自动拼合）
				window.setTimeout(() => this.scheduleRefresh(), 600);
			})
		);
		// 主题切换 → 重渲染（进度条颜色适配亮色/暗色）
		this.registerEvent(
			this.app.workspace.on('css-change', () => this.scheduleRefresh())
		);
		// 窗口/面板尺寸变化 → 重新定位进度条（offsetLeft 随字体、
		// 缩进与面板宽度变化，复测避免定位停留在旧值或 0）
		this.registerDomEvent(window, 'resize', () => this.scheduleRefresh());

		// 阅读计时心跳（每秒）
		this.registerInterval(
			window.setInterval(() => this.tickReadTimer(), READ_TIMER_TICK_MS)
		);
		// 键鼠操作 → 刷新空闲计时（防 idle：有操作即顺延 5min 封顶）
		for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
			this.registerDomEvent(window, evt, () => {
				this.lastInputTs = Date.now();
			});
		}
		// 息屏/锁屏/切后台 → 结算当前区域（停止计时）
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.hidden) this.settleReadTimer();
		});
		// 监测社区插件页滚动位置（供 Back 按钮返回时恢复）
		this.trackCommunityPluginsScroll();
		// Show Content：悬浮目录侧边栏触发监听
		this.attachShowContent();
		// 监测 NWC 显示条目变化（data-novel-word-count-plugin），
		// 同步刷新 RP 组合信息（"RP | NWC"）
		this.trackNwcAttributes();
		// 监测文件树 DOM：文件夹展开时即时渲染进度条（折叠时节点移除自动释放）
		this.trackExplorerDom();
		// 文件树右键菜单：Reset read time（官方 file-menu 事件）
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) return;
				const path = file.path;
				menu.addItem((item: MenuItem) => {
					item
						.setTitle('Reset read time')
						.setIcon('reset')
						.onClick(() => {
							this.confirmResetReadTime(path);
						});
				});
			})
		);
		// 焦点切出 Obsidian 窗口 → 结算并停止计时。
		// document.hasFocus() 在部分环境不可靠（窗口失焦仍返回 true），
		// 以 window blur/focus 事件为准；失焦即结算，防止切到其他
		// 软件/离屏期间继续累计
		this.registerDomEvent(window, 'blur', () => {
			this.windowFocused = false;
			this.debugLog('timer paused: window blur');
			this.settleReadTimer();
		});
		this.registerDomEvent(window, 'focus', () => {
			this.windowFocused = true;
		});

		this.app.workspace.onLayoutReady(() => {
			this.attachScrollListener();
			// 初始视图的系统滚动条浓度渲染
			this.attachSystemScrollTrack();
			// 文件树可能尚未渲染完成，延迟多次扫描确保所有条目就绪
			const delays = [300, 800, 1500, 3000];
			for (const d of delays) {
				window.setTimeout(() => {
					this.scanVault();
					this.scheduleRefresh();
				}, d);
			}
			// 预填充所有 md 文件的估算阅读时长（est. time 首次直接显示真实值）
			void this.prefillEstimates();
		});
	}

	// ==================== 模块3：Show Content（悬浮目录侧边栏，Beta） =================

	/** 悬浮触发区域探测深度（事件路径向上检查的层数） */
	private static readonly SHOW_CONTENT_PROBE_DEPTH = 4;

	/** Show Content：当前显示的目录条目（切换笔记/隐藏时清空） */
	private contentHeadings: Array<{
		level: number;
		text: string;
		/** 源内容中的行号（0-based，用于跳转兜底估算） */
		line: number;
	}> = [];
	/** Show Content：当前侧边栏对应的笔记路径 */
	private contentPath: string | null = null;
	/** Show Content：侧边栏 DOM（未显示为 null） */
	private contentSidebar: HTMLElement | null = null;
	/** Show Content：侧边栏挂载的滚动容器（滚动时更新高亮） */
	private contentScroller: HTMLElement | null = null;
	/** Show Content：滚动监听（滚动时更新当前节点高亮） */
	private contentScrollListener: (() => void) | null = null;
	/** Show Content：侧边栏宿主容器（挂载 pointerdown 清理监听） */
	private contentSidebarHost: HTMLElement | null = null;
	/** Show Content：高亮锁定（跳转期间锁定目标节点） */
	private contentActiveLocked = false;
	/** Show Content：锁定的高亮索引 */
	private contentActiveLockIdx = -1;
	/** Show Content：笔记内容缓存（path → 目录条目），避免悬浮时重复读文件 */
	private contentCache = new Map<
		string,
		Array<{ level: number; text: string; line: number }>
	>();
	/** Show Content：悬浮浮现延时（静止悬浮 300ms 才浮现） */
	private contentHoverTimer: number | null = null;
	/** Show Content：当前悬浮的触发位置（校验静止期间鼠标未移动） */
	private contentHoverPos: { x: number; y: number } | null = null;
	/** Show Content：触发悬浮的正文视图与滚动容器（延时回调使用） */
	private contentHoverCtx: {
		view: MarkdownView;
		scroller: HTMLElement;
	} | null = null;

	/**
	 * 挂载 Show Content 触发监听。
	 * 监听整个 workspace 的 pointerover（捕获）：悬浮位置在正文视图
	 * cm-scroller 左侧 padding 区域（非文本显示区）时浮现目录侧边栏，
	 * 鼠标移除该区域后浮出。
	 */
	private attachShowContent(): void {
		this.detachShowContent();
		if (!this.settings.showContent) return;
		this.registerDomEvent(
			this.app.workspace.containerEl,
			'pointerover',
			(e: PointerEvent) => this.onShowContentHover(e),
			true
		);
	}

	/** 卸载 Show Content（开关关闭/插件卸载时） */
	private detachShowContent(): void {
		this.cancelContentHoverTimer();
		this.hideContentSidebar();
		this.contentCache.clear();
	}

	/** 取消待执行的悬浮浮现计时（鼠标移动/移出时调用） */
	private cancelContentHoverTimer(): void {
		if (this.contentHoverTimer !== null) {
			window.clearTimeout(this.contentHoverTimer);
			this.contentHoverTimer = null;
		}
		this.contentHoverPos = null;
		this.contentHoverCtx = null;
	}

	/**
	 * 悬浮检测：事件路径上的祖先链中存在「正文视图的
	 * cm-scroller 左侧 padding 区域」时，静止悬浮 300ms
	 * 后浮现目录侧边栏；鼠标移动或移出该区域时取消/浮出。
	 */
	private onShowContentHover(e: PointerEvent): void {
		const path = e.composedPath();
		let scroller: HTMLElement | null = null;
		const depth = Math.min(
			path.length,
			ReadProgressPlugin.SHOW_CONTENT_PROBE_DEPTH
		);
		for (let i = 0; i < depth; i++) {
			const node = path[i];
			if (!(node instanceof HTMLElement)) continue;
			if (!node.classList.contains('cm-scroller')) continue;
			if (!this.isLiveScroller(node)) continue;
			scroller = node;
			break;
		}
		if (!scroller) {
			// 鼠标移出正文滚动容器：取消待浮现计时，侧边栏浮出
			this.cancelContentHoverTimer();
			if (this.contentSidebar && !this.contentSidebar.contains(e.target as Node)) {
				this.hideContentSidebar();
			}
			return;
		}
		// 悬浮点须落在左侧 padding 区域（非文本显示区）：
		// clientX 在 scroller 内、文本区起点之前
		const rect = scroller.getBoundingClientRect();
		if (e.clientX < rect.left || e.clientX >= rect.right) return;
		const textX = this.getScrollerTextX(scroller);
		if (e.clientX >= textX) return;
		// 命中触发区域：静止悬浮 300ms 后浮现
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const path2 = view?.file?.path;
		if (!view || !path2) return;
		// 鼠标移动（位置变化）→ 重新计时
		const pos = { x: e.clientX, y: e.clientY };
		if (
			this.contentHoverCtx?.view !== view ||
			this.contentHoverCtx?.scroller !== scroller ||
			this.contentHoverPos?.x !== pos.x ||
			this.contentHoverPos?.y !== pos.y
		) {
			this.cancelContentHoverTimer();
			this.contentHoverCtx = { view, scroller };
			this.contentHoverPos = pos;
			this.contentHoverTimer = window.setTimeout(() => {
				this.contentHoverTimer = null;
				this.contentHoverPos = null;
				const ctx = this.contentHoverCtx;
				this.contentHoverCtx = null;
				if (!ctx) return;
				// 300ms 后校验鼠标仍停留在触发位置（静止悬浮）
				const r = ctx.scroller.getBoundingClientRect();
				if (
					pos.x < r.left ||
					pos.x >= this.getScrollerTextX(ctx.scroller)
				) {
					return;
				}
				void this.ensureContentHeadings(ctx.view.file).then(() => {
					this.showContentSidebar(ctx.view, ctx.scroller, path2);
				});
			}, 300);
		}
	}

	/** 判断 cm-scroller 是否属于正文视图（排除侧边栏笔记摘要等嵌入式 cm） */
	private isLiveScroller(scroller: HTMLElement): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return false;
		return view.containerEl.contains(scroller);
	}

	/**
	 * scroller 内文本显示区的左边界 x。
	 * 阅读视图：首个行内内容元素（.markdown-line / .cm-line）的左缘；
	 * 实时预览：CodeMirror 行容器；无内容时回退 clientLeft 内边距。
	 */
	private getScrollerTextX(scroller: HTMLElement): number {
		const line = scroller.querySelector<HTMLElement>(
			'.markdown-preview-view .markdown-line, .markdown-preview-view p, .cm-line'
		);
		if (line) {
			const r = line.getBoundingClientRect();
			if (r.width > 0) return r.left;
		}
		return scroller.getBoundingClientRect().left + scroller.clientLeft + 24;
	}

	/**
	 * 解析笔记的结构化目录（标题层级 + 文本 + 行号）。
	 * 支持显式 # 标题与 Obsidian 块标题（^block-id 行的前置文本）。
	 * 行号为原始文档行号（含 frontmatter 偏移，0-based），
	 * 与 CodeMirror 6 的行号（1-based）差 1。
	 * 结果按路径缓存，文件变化时失效。
	 */
	private async ensureContentHeadings(file: TFile): Promise<void> {
		if (this.contentCache.has(file.path)) return;
		let content = '';
		try {
			content = await this.app.vault.read(file);
		} catch {
			return;
		}
		const headings = this.parseHeadings(content);
		this.contentCache.set(file.path, headings);
	}

	/** 从笔记内容解析目录条目（level 1~6，空文本跳过） */
	private parseHeadings(
		content: string
	): Array<{ level: number; text: string; line: number }> {
		const headings: Array<{
			level: number;
			text: string;
			line: number;
		}> = [];
		// 去除 frontmatter，记录其行数偏移（行号需加回）
		let fmOffset = 0;
		if (content.startsWith('---')) {
			const end = content.indexOf('\n---', 3);
			if (end !== -1) {
				fmOffset =
					content.slice(0, end + 4).split('\n').length - 1;
				content = content.slice(end + 4);
			}
		}
		const rawLines = content.split('\n');
		for (let i = 0; i < rawLines.length; i++) {
			const line = rawLines[i].trim();
			if (!line) continue;
			// ATX 标题：# ~ ######
			const m = line.match(/^(#{1,6})\s+(.+)$/);
			if (m) {
				const text = m[2].trim();
				if (text) {
					headings.push({ level: m[1].length, text, line: i + fmOffset });
				}
				continue;
			}
			// 块标题（Obsidian）：行内 ^block-id 作为标题
			const b = line.match(/^(.+?)\s+\^[A-Za-z0-9-]+$/);
			if (b && b[1].trim()) {
				headings.push({ level: 3, text: b[1].trim(), line: i + fmOffset });
			}
		}
		return headings;
	}

	/** 缓存失效：当前笔记内容变化（编辑/保存）时重新解析目录 */
	private invalidateContentCache(path: string): void {
		if (!this.contentCache.delete(path)) return;
		// 侧边栏正在显示该笔记：异步重解析后重渲染
		if (this.contentPath === path && this.contentSidebar) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = view?.file;
			if (!view || !file || file.path !== path) return;
			void this.ensureContentHeadings(file).then(() => {
				if (this.contentPath !== path || !this.contentSidebar) return;
				this.contentHeadings = this.contentCache.get(path) ?? [];
				this.renderContentSidebar();
				this.updateContentActive();
			});
		}
	}

	/**
	 * 显示目录侧边栏。
	 * 覆盖在当前笔记区域左侧，从左侧动画浮入；
	 * 内容为已结构化布局的笔记目录，当前阅读节点高亮，
	 * 点击任意节点跳转。
	 */
	private showContentSidebar(
		view: MarkdownView,
		scroller: HTMLElement,
		path: string
	): void {
		// 切换笔记：重建侧边栏
		let isNew = false;
		if (this.contentPath !== path || !this.contentSidebar) {
			isNew = true;
			this.hideContentSidebar();
			this.contentPath = path;
			this.contentHeadings = this.contentCache.get(path) ?? [];
			// 挂到正文内容容器（不随笔记内容滚动），absolute 定位：
			// 显示层级只在正文区域内，不会覆盖左侧文件目录
			// （workspace-leaf-content）等其他 leaf
			const host = view.contentEl ?? scroller;
			host.addClass('erp-content-host');
			this.contentSidebarHost = host;
			this.contentSidebar = host.createDiv({
				cls: 'erp-content-sidebar'
			});
			this.renderContentSidebar();
			this.updateContentActive();
			// 点击节点 → 跳转对应标题
			this.contentSidebar.addEventListener('click', (ev) => {
				const item = (ev.target as HTMLElement).closest<HTMLElement>(
					'.erp-content-item'
				);
				if (!item) return;
				const idx = Number(item.dataset.erpIdx);
				this.scrollToHeading(view, scroller, idx);
			});
			// 悬浮在侧边栏上时保持显示
			this.contentSidebar.addEventListener('pointerenter', () => {
				this.contentSidebar?.addClass('is-hover');
			});
			this.contentSidebar.addEventListener('pointerleave', () => {
				this.contentSidebar?.removeClass('is-hover');
			});
			// 点击空白处（非侧边栏条目）时立即收起
			const onDown = (ev: PointerEvent): void => {
				if (!this.contentSidebar) return;
				if (this.contentSidebar.contains(ev.target as Node)) return;
				this.hideContentSidebar();
			};
			this.contentSidebar.addEventListener('pointerdown', (ev) => {
				ev.stopPropagation();
			}, true);
			scroller.addEventListener('pointerdown', onDown, true);
			// 记录清理回调：隐藏时移除 scroller 级监听
			(this.contentSidebar as HTMLElement & {
				erpOnDown?: (ev: PointerEvent) => void;
			}).erpOnDown = onDown;
			this.contentSidebarHost = scroller;
		}
		// 重新定位（覆盖在正文内容区左侧，从左侧浮入；
		// 定位由 .erp-content-sidebar 定义，正文容器由 .erp-content-host 定义）
		const sidebar = this.contentSidebar;
		// 显示（新建时从左侧浮入动画：先隐藏，下一帧浮现触发过渡）
		if (isNew) {
			sidebar.addClass('is-hidden');
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					sidebar.removeClass('is-hidden');
				});
			});
			// 标题 DOM 可能尚未渲染完成，延迟更新高亮
			window.setTimeout(() => this.updateContentActive(), 120);
			window.setTimeout(() => this.updateContentActive(), 400);
		} else {
			sidebar.removeClass('is-hidden');
		}
		// 滚动时更新当前节点高亮（容器切换时重挂）
		if (this.contentScroller !== scroller) {
			if (this.contentScroller && this.contentScrollListener) {
				this.contentScroller.removeEventListener(
					'scroll',
					this.contentScrollListener,
					true
				);
			}
			this.contentScroller = scroller;
			this.contentScrollListener = () =>
				this.updateContentActive();
			scroller.addEventListener(
				'scroll',
				this.contentScrollListener,
				true
			);
		}
	}

	/** 渲染目录条目（结构化缩进布局） */
	private renderContentSidebar(): void {
		const sidebar = this.contentSidebar;
		if (!sidebar) return;
		sidebar.empty();
		// 顶部标题栏（居中显示 Content）
		sidebar.createDiv({ cls: 'erp-content-header', text: 'Content' });
		// 目录主体（独立滚动，标题栏/页脚固定）
		const body = sidebar.createDiv({ cls: 'erp-content-body' });
		const headings = this.contentHeadings;
		if (headings.length === 0) {
			body.createDiv({
				cls: 'erp-content-empty',
				text: 'No headings'
			});
		} else {
			const minLevel = Math.min(...headings.map((h) => h.level));
			headings.forEach((h, idx) => {
				const item = body.createDiv({
					cls: 'erp-content-item',
					attr: { 'data-erp-idx': String(idx) }
				});
				// 相对最小层级缩进（level 差 → 缩进档）
				const indent = Math.max(0, h.level - minLevel);
				item.style.setProperty(
					'--erp-content-indent',
					String(indent)
				);
				item.createSpan({ cls: 'erp-content-mark', text: 'H' + h.level });
				item.createSpan({
					cls: 'erp-content-text',
					text: h.text
				});
			});
		}
		// 底部页脚（20% 透明度，不起眼）
		sidebar.createDiv({
			cls: 'erp-content-footer',
			text: '— Read Progress —'
		});
	}

	/** 高亮当前阅读的节点 */
	private updateContentActive(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sidebar = this.contentSidebar;
		if (!view || !sidebar || this.contentPath !== view.file?.path) return;
		// 跳转期间高亮锁定在目标节点（用户点击的即当前阅读节点）
		if (this.contentActiveLocked) {
			this.applyContentActive(sidebar, this.contentActiveLockIdx);
			return;
		}
		const headings = this.contentHeadings;
		if (headings.length === 0) return;
		const scroller = this.getScrollTarget(view);
		if (!scroller) return;
		// 当前阅读行 = 视口垂直中心处（与跳转落位一致）的
		// 源码行号。用 CM6 lineBlockAtHeight 依据真实视口布局
		// 求解该像素位置对应的行，精确（非估算）。
		const currentLine = this.getContentLineAt(scroller);
		if (currentLine < 0) return;
		let activeIdx = -1;
		for (let i = 0; i < headings.length; i++) {
			if (headings[i].line <= currentLine) activeIdx = i;
			else break;
		}
		this.applyContentActive(sidebar, activeIdx);
	}

	/**
	 * 取滚动容器「垂直中心」处的源码行号（0-based）。
	 * 通过 CodeMirror 6 lineBlockAtHeight 由真实视口布局求得，
	 * 该像素位置在视口内、有实测行高，故结果精确。
	 * 非编辑视图（如阅读模式）或 API 不可用时返回 -1。
	 */
	private getContentLineAt(scroller: HTMLElement): number {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = (
			view?.editor as unknown as {
				cm?: {
					state: {
						doc: { lineAt: (pos: number) => { number: number } };
					};
					lineBlockAtHeight?: (h: number) => { from: number };
				};
			}
		)?.cm;
		if (
			!cm?.state?.doc ||
			typeof cm.lineBlockAtHeight !== 'function'
		) {
			return -1;
		}
		try {
			const offset = Math.min(
				scroller.scrollTop - scroller.clientHeight * 0.15,
				scroller.scrollHeight
			);
			const block = cm.lineBlockAtHeight(offset);
			return cm.state.doc.lineAt(block.from).number - 1;
		} catch {
			return -1;
		}
	}

	/** 应用高亮到指定索引的目录条目 */
	private applyContentActive(
		sidebar: HTMLElement,
		activeIdx: number
	): void {
		sidebar
			.querySelectorAll<HTMLElement>('.erp-content-item')
			.forEach((el) => {
				const idx = Number(el.dataset.erpIdx);
				el.toggleClass('is-active', idx === activeIdx);
			});
	}

	/** 跳转到指定标题（落位视口顶部往下 10%），并保持侧边栏显示、更新高亮 */
	private scrollToHeading(
		view: MarkdownView,
		scroller: HTMLElement,
		idx: number
	): void {
		const heading = this.contentHeadings[idx];
		if (!heading) return;
		const editor = view.editor;
		// 目标行（0-based 源码行号，越界钳制）
		const target = Math.max(
			0,
			Math.min(heading.line, editor.lineCount() - 1)
		);
		try {
			// 先用公开 API 把目标行滚动进视口（由 CodeMirror 依据
			// 真实行高落位，不受 height map 估算偏差影响）
			editor.scrollIntoView(
				{
					from: { line: target, ch: 0 },
					to: { line: target, ch: 0 }
				},
				true
			);
		} catch {
			/* 编辑器 API 不可用时仅更新高亮 */
		}
		// offset 补偿：目标行进入视口后其几何为实测值，
		// 读取该行真实位置，把它校正到视口垂直中心处
		// （与目录高亮落位统一）。不做任何比例估算。
		const cm = (
			view.editor as unknown as {
				cm?: {
					state: {
						doc: { line: (n: number) => { from: number } };
					};
					lineBlockAt: (pos: number) => { top: number };
				};
			}
		)?.cm;
		window.requestAnimationFrame(() => {
			try {
				if (
					!cm?.state?.doc ||
					typeof cm.lineBlockAt !== 'function'
				) {
					return;
				}
				const pos = cm.state.doc.line(target + 1).from;
				const block = cm.lineBlockAt(pos);
				scroller.scrollTo({
					top: Math.max(
						0,
						block.top + scroller.clientHeight * 0.2
					),
					behavior: 'smooth'
				});
			} catch {
				/* 补偿失败时保留 scrollIntoView 结果 */
			}
		});
		// 滚动动画期间锁定高亮到目标节点，结束后恢复按位置计算
		this.lockContentActive(idx);
		window.setTimeout(() => {
			this.unlockContentActive();
			this.updateContentActive();
		}, 600);
	}

	/** 锁定高亮到指定目录条目（跳转期间使用） */
	private lockContentActive(idx: number): void {
		this.contentActiveLocked = true;
		this.contentActiveLockIdx = idx;
		if (this.contentSidebar) {
			this.applyContentActive(this.contentSidebar, idx);
		}
	}

	/** 解除高亮锁定（滚动停止后恢复按位置计算） */
	private unlockContentActive(): void {
		this.contentActiveLocked = false;
		this.contentActiveLockIdx = -1;
	}

	/** 隐藏目录侧边栏（鼠标移除触发区域后渐变浮出） */
	private hideContentSidebar(): void {
		const sidebar = this.contentSidebar;
		if (!sidebar) return;
		this.contentSidebar = null;
		this.contentPath = null;
		this.contentHeadings = [];
		// 重置高亮锁定
		this.contentActiveLocked = false;
		this.contentActiveLockIdx = -1;
		// 移除滚动监听
		if (this.contentScroller && this.contentScrollListener) {
			this.contentScroller.removeEventListener(
				'scroll',
				this.contentScrollListener,
				true
			);
		}
		this.contentScroller = null;
		this.contentScrollListener = null;
		// 移除 scroller 级 pointerdown 监听
		const wrapper = sidebar as HTMLElement & {
			erpOnDown?: (ev: PointerEvent) => void;
		};
		if (wrapper.erpOnDown && this.contentSidebarHost) {
			this.contentSidebarHost.removeEventListener(
				'pointerdown',
				wrapper.erpOnDown,
				true
			);
			wrapper.erpOnDown = undefined;
		}
		this.contentSidebarHost = null;
		sidebar.addClass('is-hidden');
		// 等待浮出动画完成后移除 DOM
		window.setTimeout(() => sidebar.remove(), 260);
	}

	/** 批量预填充估算阅读时长缓存（onLayoutReady 后执行） */
	private async prefillEstimates(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		// 分批读取，避免一次性读取大量文件阻塞
		const batch = 20;
		for (let i = 0; i < files.length; i += batch) {
			const chunk = files.slice(i, i + batch);
			await Promise.all(
				chunk.map(async (file) => {
					if (this.estCache.has(file.path)) return;
					let content = '';
					try {
						content = await this.app.vault.read(file);
					} catch {
						return;
					}
					this.estCache.set(file.path, this.computeEstimate(content));
				})
			);
			// 每批完成后刷新文件树
			this.scheduleRefresh();
		}
	}

	/** 估算阅读时长（分钟）：CJK 500字/分 + 英文 265词/分 */
	private computeEstimate(content: string): number {
		// 去除 frontmatter（--- 包裹的 YAML 头）
		if (content.startsWith('---')) {
			const end = content.indexOf('\n---', 3);
			if (end !== -1) content = content.slice(end + 4);
		}
		// CJK 字符数（汉字/假名/谚文）
		const cjk = (content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
		// 英文词数：非 CJK 部分按空白分词
		const nonCjk = content.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ');
		const words = (nonCjk.match(/\S+/g) ?? []).length;
		return cjk / 500 + words / 265;
	}

	/**
	 * 监测 NWC 显示条目属性变化。
	 * NWC 在 layout-change 时防抖更新 data-novel-word-count-plugin，
	 * RP 读取该值拼接组合信息；属性变化时定向刷新对应条目。
	 */
	private trackNwcAttributes(): void {
		this.nwcObserver = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type !== 'attributes') continue;
				const titleEl = m.target as HTMLElement;
				const path = titleEl.getAttribute('data-path');
				if (path && (path.endsWith('.md') || path.endsWith('.pdf'))) {
					this.schedulePathRefresh(path);
				}
			}
		});
		this.nwcObserver.observe(this.app.workspace.containerEl, {
			attributes: true,
			subtree: true,
			attributeFilter: ['data-novel-word-count-plugin']
		});
	}

	/** 监测文件树 DOM 变化：文件夹展开时，新进入 DOM 的文件节点
	 *  即时渲染阅读浓度进度条（无需打开同目录笔记）；
	 *  折叠文件夹时节点从 DOM 移除，进度条随之消失（不占内存）。
	 *  仅观察各文件树容器（变化少），避免观察整个 workspace
	 *  导致编辑器输入也触发回调。 */
	private trackExplorerDom(): void {
		// 待处理的文件树容器（文件夹展开时分批插入，
		// 收集后延迟一帧统一处理，等批量 DOM 构建完成）
		const pending: HTMLElement[] = [];
		let scheduled = false;
		const flush = (): void => {
			scheduled = false;
			const batch = pending.splice(0, pending.length);
			for (const node of batch) {
				const titles: HTMLElement[] = node.matches(
					'.nav-file-title[data-path]'
				)
					? [node]
					: Array.from(
							node.querySelectorAll<HTMLElement>(
								'.nav-file-title[data-path]'
					)
				);
				for (const titleEl of titles) {
					// 跳过已渲染的条目（避免重复构建）
					if (
						titleEl.querySelector(
							':scope > .explorer-reading-progress-container'
					)
					) {
						continue;
					}
					const path = titleEl.getAttribute('data-path') || '';
					if (path) this.decorateDom(titleEl, path);
				}
			}
		};
		this.explorerObserver = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type !== 'childList') continue;
				m.addedNodes.forEach((node) => {
					if (!node.instanceOf(HTMLElement)) return;
					pending.push(node);
				});
			}
			if (!scheduled && pending.length) {
				scheduled = true;
				window.setTimeout(flush, 50);
			}
		});
		for (const view of this.getExplorerViews()) {
			const container = view.containerEl;
			if (container) {
				this.explorerObserver.observe(container, {
					childList: true,
					subtree: true,
				});
			}
		}
	}

	onunload() {
		// 结算阅读时长并停止滚动监听
		this.settleReadTimer();
		this.detachScrollListener();
		this.detachSystemScrollTrack();
		this.detachShowContent();
		this.debouncedSave.cancel();
		// 取消防抖后补写一次，落盘未写入的进度（否则卸载会丢失最后一段）
		this.persistProgress.cancel();
		void this.saveSettings();
		// 断开设置页监测器
		this.settingObserver?.disconnect();
		this.settingObserver = null;
		// 断开 NWC 属性监测器
		this.nwcObserver?.disconnect();
		this.nwcObserver = null;
		// 断开文件树 DOM 监测器
		this.explorerObserver?.disconnect();
		this.explorerObserver = null;
		// 清理所有装饰 DOM，无残留
		this.cleanupDecorations();
	}

	/**
	 * 监测社区插件页的滚动位置。
	 * 用户从社区插件页进入本插件设置时记录滚动位置；
	 * 点击 Back 返回时恢复，避免回到列表顶部。
	 * 通过 MutationObserver 检测社区插件内容区（.installed-plugins-container）
	 * 出现，附加滚动监听到可滚动的祖先容器。
	 */
	private trackCommunityPluginsScroll(): void {
		this.settingObserver = new MutationObserver(() => {
			const content = document.querySelector<HTMLElement>('.vertical-tab-content-container');
			// 仅社区插件页激活时记录（内容区包含已安装插件列表）
			if (!content || !content.querySelector('.installed-plugins-container')) return;
			if (content.dataset.erpScrollTracked) return;
			content.dataset.erpScrollTracked = '1';
			content.addEventListener('scroll', () => {
				this.communityScrollTop = content.scrollTop;
			});
		});
		this.settingObserver.observe(document.body, { childList: true, subtree: true });
	}

	/** 恢复社区插件页滚动位置（Read Progress 条目所在位置） */
	private restoreCommunityPluginsScroll(): void {
		const content = document.querySelector<HTMLElement>('.vertical-tab-content-container');
		if (!content || !content.querySelector('.installed-plugins-container')) return;
		content.scrollTop = this.communityScrollTop;
	}

	// ==================== 右键菜单：Reset read time ====================

	/**
	 * 确认弹窗："Reset read time"。
	 * 确认 → 删除该笔记阅读时长并刷新；取消 → 退出。
	 */
	private confirmResetReadTime(path: string): void {
		const modal = document.body.createDiv({
			cls: 'modal-container erp-reset-modal'
		});
		const popup = modal.createDiv({ cls: 'erp-reset-popup' });
		popup.createDiv({
			cls: 'erp-reset-popup-title',
			text: 'Reset read time'
		});
		popup.createDiv({
			cls: 'erp-reset-popup-desc',
			text: 'This operation will delete read time of this file, please confirm.'
		});
		const btnRow = popup.createDiv({ cls: 'erp-reset-popup-btns' });
		const onClose = (): void => modal.remove();
		btnRow.createEl('button', {
			cls: 'mod-cta',
			text: 'Confirm'
		}).addEventListener('click', () => {
			void this.resetReadTime(path);
			onClose();
		});
		btnRow.createEl('button', { text: 'Cancel' }).addEventListener(
			'click',
			onClose
		);
		// 点击弹窗外区域 → 取消
		modal.addEventListener('click', (ev) => {
			if (ev.target === modal) onClose();
		});
		// Esc → 取消
		const onKey = (ev: KeyboardEvent): void => {
			if (ev.key === 'Escape') {
				onClose();
				window.removeEventListener('keydown', onKey, true);
			}
		};
		window.addEventListener('keydown', onKey, true);
	}

	/** 删除某笔记的阅读时长（进度数据 + 界面刷新） */
	private async resetReadTime(path: string): Promise<void> {
		delete this.progressData[path];
		await this.saveSettings();
		this.schedulePathRefresh(path);
		// 若当前正在阅读该笔记：停止计时
		if (this.readTimer?.path === path) {
			this.readTimer = null;
		}
		// 若系统滚动渲染正指向该笔记：清理渐变
		if (this.sysScrollPath === path && this.sysScrollEl) {
			this.sysScrollEl.style.removeProperty('--erp-sys-scroll-grad');
		}
	}

	// ==================== 模块1：滚动进度采集 ====================

	/** 给当前激活的正文视图挂载滚动监听（Markdown 或 PDF） */
	private attachScrollListener() {
		this.detachScrollListener();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			this.attachMarkdownScroll(view);
			return;
		}
		const pdfView = this.getActivePdfView();
		if (pdfView) {
			this.attachPdfScroll(pdfView);
			return;
		}
		// Excalidraw 绘图：无滚动容器，按「停留时长」计入 read time
		const exView = this.getActiveExcalidrawView();
		if (exView?.file) {
			this.startReadTimer(exView.file.path, 0, 1, 1, 'px');
		}
	}

	/** 给当前激活的 Markdown 视图挂载滚动监听 */
	private attachMarkdownScroll(view: MarkdownView) {
		const file = view.file;
		if (!file || file.extension !== 'md') return;

		// 阅读视图（preview）与实时预览（source）都采集
		const viewMode = view.getMode();
		if (viewMode !== 'preview' && viewMode !== 'source') return;

		// 捕获阶段挂在稳定的 leaf 容器上：编辑↔阅读模式切换会重建
		// 内部滚动容器（且不触发 active-leaf-change），挂容器可免重挂，
		// 并在回调中动态解析真正的滚动元素（阅读视图下
		// previewMode.containerEl 可能不是滚动元素）
		const container = view.containerEl;
		const listener = (e?: Event) => {
			const target = e?.target;
			if (!(target instanceof HTMLElement)) return;
			if (!this.isMdScroller(target, view)) return;
			// 系统滚动渲染：滚动容器与已挂载不一致时自愈重挂
			if (
				this.settings.beta &&
				this.settings.systemScrollRendering &&
				this.sysScrollEl !== target
			) {
				this.mountSystemScrollTrack(target, file.path);
			}
			this.recordMdScroll(file, target);
		};
		container.addEventListener('scroll', listener, true);
		// 挂载后立即采集一次（记录当前位置）
		const scroller = this.getScrollTarget(view);
		if (scroller) {
			listener({ target: scroller } as unknown as Event);
		}
		this.scrollBinding = {
			target: container,
			listener,
			path: file.path,
			capture: true,
			scroller: scroller ?? undefined,
		};

		// 恢复上次阅读位置（开关开启且有记录时）。
		// 用 rAF 递归轮询：视图内容一渲染完成（scrollHeight 就绪）
		// 立即恢复，比固定延时更快，避免先闪一下顶部再跳转。
		// 仅在仍未滚动（scrollTop=0）时恢复，避免覆盖用户手动滚动
		if (this.settings.restoreMdPosition) {
			const saved = this.mdPositions[file.path];
			if (saved && saved > 0) {
				const tryRestore = (remaining: number): void => {
					// 已切走其他视图：放弃恢复
					const active = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (!active || !active.file || active.file.path !== file.path) return;
					const el = this.getScrollTarget(view);
					if (!el || el.scrollTop !== 0) return;
					if (el.scrollHeight <= 0) {
						// 尚未就绪：下一帧再试（最多 60 帧 ≈ 1s）
						if (remaining > 0) {
							window.requestAnimationFrame(() => tryRestore(remaining - 1));
						}
						return;
					}
					el.scrollTop = saved;
				};
				tryRestore(60);
			}
		}
	}

	/** 判断元素是否为 md 正文滚动容器（阅读视图 / 实时预览） */
	private isMdScroller(el: HTMLElement, view: MarkdownView): boolean {
		if (!view.containerEl.contains(el)) return false;
		return (
			el.classList.contains('markdown-preview-view') ||
			el.classList.contains('markdown-reading-view') ||
			el.classList.contains('cm-scroller')
		);
	}

	/** 采集一次 md 滚动位置并写入（区间指纹去重） */
	private recordMdScroll(file: TFile, scrollEl: HTMLElement): void {
		const info = this.getScrollInfo(scrollEl);
		if (!info) return;
		const { top, height: total, clientHeight: vh } = info;
		const key = `${top.toFixed(1)}|${vh.toFixed(1)}|${total.toFixed(1)}`;
		if (this.lastWritten.get(file.path) === key) return;
		this.lastWritten.set(file.path, key);
		this.debouncedSave(file, top, vh, total, 'px');
	}

	/** 获取当前激活的内部 PDF 视图（未公开类，鸭子类型识别） */
	private getActivePdfView(): PdfViewLike | null {
		const view = (this.app.workspace.activeLeaf?.view ??
			null) as unknown as PdfViewLike | null;
		if (!view?.viewer) return null;
		if (!view.file || view.file.extension !== 'pdf') return null;
		return view;
	}

	/** 获取 PDF 视图的 pdf.js 查看器（child 异步就绪，可能为 null） */
	private getPdfChild(): PdfViewerChildLike | null {
		const view = this.getActivePdfView();
		return view?.viewer?.child ?? null;
	}

	/** 获取当前激活的 Excalidraw 绘图视图（第三方插件，鸭子类型识别） */
	private getActiveExcalidrawView(): ExcalidrawViewLike | null {
		const view = (this.app.workspace.activeLeaf?.view ??
			null) as unknown as ExcalidrawViewLike | null;
		if (!view || typeof view.getViewType !== 'function') return null;
		if (view.getViewType() !== 'excalidraw') return null;
		return view.file ? view : null;
	}

	/** 给当前激活的 PDF 视图挂载阅读位置监听 */
	private attachPdfScroll(view: PdfViewLike) {
		const file = view.file;
		if (!file) return;

		// child 异步创建：先注册回调，轮询兜底（防时序竞争）
		const ready = () => this.bindPdfScroll(view, file);
		view.viewer?.then?.(ready);
		// 轮询：child 在 then 回调注册前已就绪时，靠轮询接管
		const poll = window.setInterval(() => {
			if (this.scrollBinding?.path === file.path || !this.getActivePdfView()) {
				window.clearInterval(poll);
				return;
			}
			if (this.getPdfChild()) {
				window.clearInterval(poll);
				ready();
			}
		}, 250);
		// 最多轮询 10s（PDF 长时间未加载则放弃）
		window.setTimeout(() => window.clearInterval(poll), 10000);
	}

	/** 绑定 PDF 滚动/翻页监听（child 就绪后调用） */
	private bindPdfScroll(view: PdfViewLike, file: TFile): void {
		// 已绑定（或已切走）则跳过
		if (this.scrollBinding?.path === file.path) return;
		if (this.getActivePdfView() !== view) return;
		const pv = this.getPdfChild()?.pdfViewer;
		if (!pv) return;
		// 滚动容器：连续模式为 dom.viewerContainerEl；单页模式无滚动容器（靠 pagechanging）
		const container = pv.dom?.viewerContainerEl ?? null;

		const listener = () => {
			const pagesCount = pv.pagesCount ?? 0;
			// PDF 尚未加载完成：不采集
			if (!pagesCount) return;
			// 连续滚动模式：容器可滚动，按像素位置记录（与 md 同精度，
			// 页内滚动位置也计入进度，而非整页粒度）
			if (container && container.scrollHeight > container.clientHeight) {
				const top = container.scrollTop;
				const total = container.scrollHeight;
				const vh = container.clientHeight;
				if (total > 0 && vh > 0) {
					const pxKey = `${top.toFixed(1)}|${vh.toFixed(1)}|${total.toFixed(1)}`;
					if (this.lastWritten.get(file.path) === pxKey) return;
					this.lastWritten.set(file.path, pxKey);
					this.debouncedSave(file, top, vh, total, 'px');
				}
				return;
			}
			// 单页模式：按页码记录（连续模式滚动也会更新 page）。
			// pdf.js 的 page 是 1-based（首页=1），桶模型按 0-based
			// 映射，不转换会让所有标记右移一页（短文档尤为明显）
			const page = Math.max(0, (pv.page ?? 1) - 1);
			// 用页码指纹跳过无变化的写入（避免频繁写盘）
			const key = `p${page}|1|${pagesCount}`;
			if (this.lastWritten.get(file.path) === key) return;
			this.lastWritten.set(file.path, key);
			this.debouncedSave(file, page, 1, pagesCount, 'page');
		};

		container?.addEventListener('scroll', listener);
		// 翻页按钮/目录跳转/单页模式翻页不一定伴随滚动，hook pdf.js 事件兜底
		pv.eventBus?.on('pagechanging', listener);
		// 挂载后立即采集一次（记录当前位置）
		listener();
		this.scrollBinding = {
			target: container ?? view.containerEl,
			listener,
			path: file.path,
			eventBus: pv.eventBus,
		};
	}

	/** 移除滚动监听（切换笔记时调用，同时结算阅读时长） */
	private detachScrollListener() {
		if (this.scrollBinding) {
			// 离开 md 笔记时立即记录当前位置（scroll 防抖可能未触发）
			const binding = this.scrollBinding;
			if (binding.path.endsWith('.md')) {
				const top = binding.scroller?.scrollTop ?? 0;
				if (top > 0) this.mdPositions[binding.path] = Math.round(top);
			}
			binding.target.removeEventListener('scroll', binding.listener, binding.capture === true);
			binding.eventBus?.off('pagechanging', binding.listener);
			this.scrollBinding = null;
		}
		// 切到其他笔记/非正文页：结算当前区域阅读时长
		this.settleReadTimer();
	}

	/**
	 * 获取滚动目标元素。
	 * 阅读视图：真正可滚动的容器（previewMode.containerEl 可能返回
	 *   不滚动的外层容器，会导致视口被误判为整篇 → 全篇均匀染色、
	 *   滚动条背景加错元素）；
	 * 实时预览：editor.cm.scrollDOM。
	 */
	private getScrollTarget(view: MarkdownView): HTMLElement | null {
		if (view.getMode() === 'preview') {
			return this.resolveReadingScroller(view);
		}
		// 实时预览：通过 editor.cm 访问 CodeMirror 6（非公开字段）
		const cm = (view.editor as unknown as { cm?: { scrollDOM?: HTMLElement } })?.cm;
		return cm?.scrollDOM ?? null;
	}

	/**
	 * 解析阅读视图真正可滚动的容器。
	 * 优先已知候选（.markdown-preview-view / .markdown-reading-view），
	 * 校验其确可滚动（scrollHeight > clientHeight）；否则在 contentEl
	 * 内遍历取可滚动量最大者。避免选中代码块等内嵌滚动元素。
	 */
	private resolveReadingScroller(view: MarkdownView): HTMLElement | null {
		const root = view.contentEl ?? null;
		if (!root) return view.previewMode?.containerEl ?? null;
		let best: HTMLElement | null = null;
		let bestOverflow = 0;
		const scan = (el: HTMLElement): void => {
			const overflow = el.scrollHeight - el.clientHeight;
			if (overflow > bestOverflow) {
				bestOverflow = overflow;
				best = el;
			}
		};
		for (const sel of ['.markdown-preview-view', '.markdown-reading-view']) {
			const el = root.querySelector<HTMLElement>(sel);
			if (el) {
				scan(el);
				if (bestOverflow > 1) return best ?? el;
			}
		}
		scan(root);
		root.querySelectorAll<HTMLElement>('*').forEach((el) => scan(el));
		return best ?? view.previewMode?.containerEl ?? null;
	}

	/** 当前激活视图是否为指定路径的正文视图（md 或 pdf 或 excalidraw） */
	private isActivePath(path: string, unit: 'px' | 'page'): boolean {
		// Excalidraw 绘图视图：按停留时长计时
		const exView = this.getActiveExcalidrawView();
		if (exView?.file?.path === path) return true;
		// PDF 视图：page 单位=单页模式；px 单位=连续滚动模式
		const pdfView = this.getActivePdfView();
		if (pdfView?.file?.path === path) {
			if (unit === 'page') return true;
			const container = pdfView.viewer?.child?.pdfViewer?.dom?.viewerContainerEl;
			return !!container && container.scrollHeight > container.clientHeight;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return !!view && !!view.file && view.file.path === path;
	}

	/** 读取滚动信息：直接从滚动元素读取 DOM 属性（scrollTop/scrollHeight/clientHeight） */
	private getScrollInfo(scrollEl: HTMLElement): ScrollInfo | null {
		const total = scrollEl.scrollHeight;
		const vh = scrollEl.clientHeight;
		// 空文档 / 文档高度为 0：不采集
		if (!total || total <= 0) return null;
		return { top: scrollEl.scrollTop, height: total, clientHeight: vh };
	}

	/**
	 * 把阅读进度写入统一数据文件（data.json）。
	 * Beta 开启：覆盖模型，记录 [top, top+vh] 为已读区域，合并到 ranges 并集。
	 * Beta 关闭：当前位置模式，ranges = [[0, top+vh]]（从顶部到当前位置）。
	 */
	private async writeProgress(
		file: TFile,
		top: number,
		vh: number,
		total: number,
		unit: 'px' | 'page'
	): Promise<void> {
		if (total <= 0 || vh <= 0) return;
		const existing = this.progressData[file.path] ?? { total, buckets: createBuckets(), readSeconds: 0 };
		// 文档总高度变化（PDF 缩放 / 内容变化）：
		// 桶按相对位置（top/total）分布，缩放只改变 total
		// 不改变相对位置——无需重分布，仅更新 total。
		// 阈值 5% 过滤滚动时的 total 抖动
		const totalDelta = Math.abs(existing.total - total) / Math.max(existing.total, 1);
		if (totalDelta > 0.05) {
			existing.total = total;
		} else {
			// 滚动时 total 不变：只增不减
			existing.total = Math.max(existing.total, total);
		}
		// 计算当前可见区域
		const start = Math.max(0, top);
		const end = Math.min(existing.total, top + vh);
		if (this.settings.beta) {
			// 覆盖模型：不写入 0 秒区域（只在结算时记录实际阅读时长），
			// 滚动停止 → 结算旧区域并开始新计时
			this.startReadTimer(file.path, start, end, existing.total, unit);
		} else {
			// 当前位置模式：从顶部到当前位置
			addToBuckets(existing.buckets, existing.total, 0, end, 1);
		}
		this.progressData[file.path] = existing;
		// 记录 md 笔记当前阅读位置（供 restoreMdPosition 恢复）
		if (file.extension === 'md' && unit === 'px') {
			this.mdPositions[file.path] = Math.round(top);
		}
		this.persistProgress();
		// 定向刷新该条目
		this.schedulePathRefresh(file.path);
		// 系统滚动渲染：滚动停止后更新浓度
		this.scheduleSysScrollRender();
	}

	// ==================== 阅读时长计时（微信读书式） ====================

	/** 调试日志：DEBUG_MODE 开启时输出到 console（内部开关，不暴露给用户） */
	private debugLog(...args: unknown[]): void {
		// 使用 window.console 绕过 no-console 规则（该规则禁止 disable）
		if (DEBUG_MODE) window.console.log('[ReadProgress]', ...args);
	}

	/**
	 * 开始新区域计时。
	 * 滚动停止（防抖）后由 writeProgress 调用。
	 * 同一笔记同一区域：md 为 ±50px（缓慢滚动不重置计时），
	 * pdf 为同一页（页是离散单位）；否则秒数永远累不到目标时长，进度条不变绿。
	 * 区域变化：先结算旧区域，再开始新计时。
	 */
	private startReadTimer(
		path: number | string,
		start: number,
		end: number,
		total: number,
		unit: 'px' | 'page'
	): void {
		const timer = this.readTimer;
		// 同一区域判定：md 按 50px 容差（缓慢滚动不重置计时）；
		// pdf 按页精确匹配——页是离散单位，容差会把整段翻阅的
		// 时长全部沉淀到最后一页，先前读过的页不留痕迹
		const sameRegion =
			!!timer &&
			timer.path === path &&
			timer.unit === unit &&
			(unit === 'page'
				? timer.start === start
				: Math.abs(timer.start - start) <= 50);
		if (sameRegion && timer) {
			// 同一区域：保留累计秒数，仅更新视口边界
			timer.start = start;
			timer.end = end;
			timer.total = total;
			return;
		}
		// 区域变化：结算旧区域，开始新计时
		this.settleReadTimer();
		this.readTimer = { path: path as string, start, end, total, credited: 0, unit };
		this.debugLog('timer start:', this.readTimer.path, `region=${Math.round(start)}-${Math.round(end)}`);
	}

	/**
	 * 结算当前区域阅读时长：把累计秒数写入覆盖模型。
	 * 翻页（区域变化）、切换笔记、卸载时调用。
	 * 快速乱翻（停留 < 3s）不计入。
	 */
	private settleReadTimer(): void {
		const timer = this.readTimer;
		if (!timer) return;
		this.readTimer = null;
		if (timer.credited < MIN_DWELL_SECONDS) {
			this.debugLog('timer discarded:', timer.path, `${timer.credited}s (< ${MIN_DWELL_SECONDS}s)`);
			return;
		}
		const existing = this.progressData[timer.path] ?? { total: timer.total, buckets: createBuckets(), readSeconds: 0 };
		existing.total = Math.max(existing.total, timer.total);
		// 总时长累加（独立总计时：不同时段的阅读时长直接相加，仅用于 read time 显示）
		existing.readSeconds += timer.credited;
		// 同一区域取峰值而非累加：滚走又滚回时，
		// 同一区域被多次结算，秒数不应重复累加
		addToBuckets(existing.buckets, existing.total, timer.start, timer.end, timer.credited, true);
		this.progressData[timer.path] = existing;
		this.debugLog('timer settled:', timer.path, `${timer.credited}s`);
		this.persistProgress();
		this.schedulePathRefresh(timer.path);
		// 系统滚动渲染：结算后浓度变化，更新
		this.scheduleSysScrollRender();
	}

	/**
	 * 阅读计时心跳（每秒）。
	 * 以下情况不计时（微信读书规则）：
	 *  - 息屏/锁屏/切后台（document.hidden）
	 *  - 焦点不在 Obsidian 窗口（失焦，聚焦后自动恢复）
	 *  - 打开可见模态框（设置页、命令面板等非正文页）
	 *  - 防 idle：持续 5min 无任何键鼠操作才封顶（有操作即顺延）
	 *  - 切换到其他笔记（结算并停止计时）
	 * 滚动（含滚轮/拖动进度条）正常计时：不排除阅读速度快
	 * 的人群采用滚动阅读方式，滚动期间与偏离区域均不暂停。
	 */
	private tickReadTimer(): void {
		const timer = this.readTimer;
		if (!timer) return;
		if (document.hidden) { this.debugLog('timer paused: page hidden'); return; }
		if (!this.windowFocused || !document.hasFocus()) {
			this.debugLog('timer paused: window not focused');
			// 失焦超时结算：blur 事件可能丢失（切换其他软件/最小化），
			// 持续失焦 3 秒后强制结算，防止残留 timer 在恢复后继续累计
			const now = Date.now();
			if (this.blurStartTs === null) this.blurStartTs = now;
			if (now - this.blurStartTs >= 3000) {
				this.settleReadTimer();
				this.blurStartTs = null;
			}
			return;
		}
		this.blurStartTs = null;
		const modal = document.querySelector<HTMLElement>('.modal-container');
		// 只把可见的模态框视为非正文页（隐藏的 suggest 残留在 DOM 中不应暂停计时）
		if (modal && modal.getClientRects().length > 0) { this.debugLog('timer paused: modal open'); return; }
		// 正文焦点检测：焦点在文件树/侧边栏等非正文区域时暂停。
		// leaf 未切换时 getActiveViewOfType 仍返回该笔记，
		// 用户在文件树/侧边栏操作会被误判为阅读而持续累计
		const active = document.activeElement;
		// 未聚焦任何元素（body）= 纯阅读，继续计时
		if (active && active !== document.body) {
			const pdfView = this.getActivePdfView();
			const exView = this.getActiveExcalidrawView();
			let inView: boolean;
			if (pdfView) inView = pdfView.containerEl.contains(active);
			else if (exView) inView = !!exView.containerEl?.contains(active);
			else {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				inView = view ? view.containerEl.contains(active) : false;
			}
			if (!inView) { this.debugLog('timer paused: focus outside reading view'); return; }
		}
		// 视图匹配检查（md 或 pdf）
		if (!this.isActivePath(timer.path, timer.unit)) {
			this.debugLog('timer paused: note switched');
			this.settleReadTimer();
			return;
		}
		// 防 idle：持续 5min 无键鼠操作才封顶（停留阅读/编辑/点击均顺延）
		const idleSeconds = Math.floor((Date.now() - this.lastInputTs) / 1000);
		if (idleSeconds >= MAX_DWELL_SECONDS) {
			this.debugLog('timer paused: idle cap reached (no input for 5min)');
			return;
		}
		timer.credited++;
		this.debugLog('timer ticking:', timer.path, `${timer.credited}s / goal ${this.settings.readGoal * 60}s`);
		// 定期刷新渲染：计时中的秒数实时反映到浓度渐变
		if (timer.credited % 5 === 0) {
			this.schedulePathRefresh(timer.path);
			this.scheduleSysScrollRender();
		}
	}

	/** 启动时预扫描：进度数据已在 loadSettings 加载，这里仅重渲染已就绪的文件树节点
	 *  （一次遍历所有已渲染节点，替代逐文件 querySelector，避免长时间阻塞） */
	private scanVault() {
		this.refreshAll();
	}

	// ==================== 系统滚动渲染（滚动条背景浓度） ====================

	/**
	 * 系统滚动渲染是否可用。
	 * 依赖 ::-webkit-scrollbar-track 伪元素给系统滚动条轨道染色；移动端
	 * （iOS/Android）滚动条为系统 overlay，不占布局、不受该伪元素影响，
	 * 故此功能仅桌面端可用。
	 */
	private isSystemScrollSupported(): boolean {
		return !Platform.isMobile;
	}

	/**
	 * 给当前激活的正文视图挂载系统滚动渲染。
	 * 把阅读浓度渲染到右侧系统滚动条所在的背景条内
	 * （::-webkit-scrollbar-track 轨道 + 动态渐变变量），
	 * 直接在当前笔记旁看到已读/未读分布。
	 * 前提：beta 模式 + systemScrollRendering 开关开启。
	 */
	private attachSystemScrollTrack(): void {
		this.detachSystemScrollTrack();
		if (!this.isSystemScrollSupported()) return;
		if (!this.settings.beta || !this.settings.systemScrollRendering) return;

		// md 视图：滚动容器（阅读视图 / 实时预览）
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (mdView?.file && mdView.file.extension === 'md') {
			const mode = mdView.getMode();
			if (mode === 'preview' || mode === 'source') {
				const scrollEl = this.getScrollTarget(mdView);
				if (scrollEl) {
					this.mountSystemScrollTrack(scrollEl, mdView.file.path);
					return;
				}
			}
		}
		// PDF 视图：连续模式滚动容器（child 异步就绪，轮询挂载）
		const pdfView = this.getActivePdfView();
		if (pdfView?.file) {
			const tryMount = (): boolean => {
				const container =
					pdfView.viewer?.child?.pdfViewer?.dom?.viewerContainerEl;
				if (
					container &&
					container.scrollHeight > container.clientHeight
				) {
					this.mountSystemScrollTrack(container, pdfView.file!.path);
					return true;
				}
				return false;
			};
			if (tryMount()) return;
			// 轮询：PDF 异步加载完成后再挂载（最多 10s）
			const path = pdfView.file.path;
			let attempts = 0;
			const poll = window.setInterval(() => {
				attempts++;
				// 已切走 / 已挂载 / 超时：停止轮询
				if (
					this.sysScrollEl ||
					this.getActivePdfView()?.file?.path !== path ||
					attempts >= 40
				) {
					window.clearInterval(poll);
					return;
				}
				tryMount();
			}, 250);
		}
	}

	/** 挂载系统滚动渲染到滚动容器（加类 + 滚动监听） */
	private mountSystemScrollTrack(scrollEl: HTMLElement, path: string): void {
		const onScroll = (): void => this.scheduleSysScrollRender();
		scrollEl.addClass('erp-sys-scroll');
		scrollEl.addEventListener('scroll', onScroll);
		this.sysScrollEl = scrollEl;
		this.sysScrollPath = path;
		this.sysScrollListener = onScroll;
		// 测量系统滚动条宽度（线宽超过它时填满背景条）
		this.sysScrollbarWidth = this.measureScrollbarWidth();
		// 初始渲染
		this.renderSystemScrollTrack();
	}

	/** 测量系统滚动条宽度（px） */
	private measureScrollbarWidth(): number {
		const probe = document.body.createDiv();
		probe.style.cssText =
			'width:100px;height:100px;overflow:scroll;' +
			'position:absolute;visibility:hidden;';
		const w = probe.offsetWidth - probe.clientWidth;
		probe.remove();
		return Math.max(0, w);
	}

	/** 移除系统滚动渲染（切走视图 / 关闭开关 / 卸载时） */
	private detachSystemScrollTrack(): void {
		const el = this.sysScrollEl;
		if (el && this.sysScrollListener) {
			el.removeEventListener('scroll', this.sysScrollListener);
		}
		if (el) {
			el.removeClass('erp-sys-scroll');
			el.style.removeProperty('--erp-sys-scroll-grad');
			el.style.removeProperty('--erp-sys-scroll-line-size');
			el.style.removeProperty('--erp-sys-scroll-pos');
		}
		this.sysScrollEl = null;
		this.sysScrollPath = null;
		this.sysScrollListener = null;
	}

	/**
	 * 渲染滚动条轨道背景浓度：把桶模型区间映射为
	 * 滚动条轨道的线性渐变（--erp-sys-scroll-grad），
	 * 并同步线宽与位置变量。
	 * 浓度（透明度）按阅读时长占目标时长适配，达到目标显示达成色。
	 */
	private renderSystemScrollTrack(): void {
		const el = this.sysScrollEl;
		const path = this.sysScrollPath;
		if (!el || !path) return;
		// 开关关闭：清理
		if (!this.settings.beta || !this.settings.systemScrollRendering) {
			this.detachSystemScrollTrack();
			return;
		}
		// 线宽：超过滚动条最大宽度则按完整填满背景条
		const lineW = this.settings.sysScrollLineWidth;
		const barW = this.sysScrollbarWidth;
		el.style.setProperty(
			'--erp-sys-scroll-line-size',
			barW > 0 && lineW >= barW ? '100%' : `${Math.max(1, lineW)}px`
		);
		// 位置：left = 从背景条左侧开始染色，right = 右侧
		el.style.setProperty(
			'--erp-sys-scroll-pos',
			this.settings.sysScrollPosition
		);
		const data = this.progressData[path];
		const total = data?.total ?? 0;
		if (!data || total <= 0) {
			el.style.removeProperty('--erp-sys-scroll-grad');
			return;
		}
		// 合并当前计时中的秒数（停留期间浓度渐变实时可见）
		let buckets = data.buckets;
		const timer = this.readTimer;
		if (timer && timer.path === path) {
			buckets = data.buckets.slice();
			addToBuckets(buckets, total, timer.start, timer.end, timer.credited);
		}
		el.style.setProperty(
			'--erp-sys-scroll-grad',
			this.buildScrollGradient(buckets, total)
		);
	}

	/**
	 * 把桶模型区间构建为滚动条轨道渐变字符串。
	 * 每个 range → 一段颜色（浓度按阅读时长适配，
	 * 达到目标时长用达成色）。
	 */
	private buildScrollGradient(
		buckets: number[],
		total: number
	): string {
		const ranges = bucketsToRanges(buckets, total);
		if (ranges.length === 0) return 'transparent';
		const goal = Math.max(1, this.settings.readGoal * 60);
		const pending =
			this.settings.pendingColor || this.getDefaultAccentColor();
		const complete = this.settings.completeColor || '#4caf50';
		// 总不透明度 = 浓度 × 用户设定（0~1）
		const opacity = Math.min(
			1,
			Math.max(0, this.settings.sysScrollOpacity)
		);
		const stops: string[] = [];
		for (const [s, e, secs] of ranges) {
			const color =
				secs >= goal ? complete : pending;
			const alpha = Math.min(
				1,
				this.getOpacity(secs) * opacity
			);
			const sp = ((s / total) * 100).toFixed(2);
			const ep = ((e / total) * 100).toFixed(2);
			// 前后加透明硬边界：否则渐变会在最后一个
			// 颜色停之后延伸到 100%，把未读区域错误点亮
			stops.push(
				`transparent ${sp}%`,
				`${hexToRgba(color, alpha)} ${sp}%`,
				`${hexToRgba(color, alpha)} ${ep}%`,
				`transparent ${ep}%`
			);
		}
		return `linear-gradient(to bottom, ${stops.join(', ')})`;
	}

	// ==================== 模块2：左侧文件树装饰渲染 ====================

	/**
	 * 计算某笔记的阅读完成度（按覆盖面积）。
	 * 已读区域并集的总长度 / 文档总高度 → 0~100。
	 * 没有记录 → 0。
	 */
	private getProgress(path: string): number {
		const data = this.progressData[path];
		if (!data || !data.total || data.total <= 0) return 0;
		let covered = 0;
		for (const secs of data.buckets) {
			if (secs > 0) covered++;
		}
		const raw = (covered / BUCKET_COUNT) * 100;
		return Math.min(100, Math.max(0, Math.round(raw)));
	}

	/**
	 * 根据区域累计阅读秒数与目标时长计算不透明度（浓淡程度）。
	 * 0 → 目标时长：15% → 75% 线性适配；达到目标由 is-complete 显示达成色。
	 */
	private getOpacity(seconds: number): number {
		const goal = Math.max(1, this.settings.readGoal * 60);
		const ratio = Math.min(1, seconds / goal);
		return Math.round((0.15 + ratio * 0.6) * 100) / 100;
	}

	/** 获取所有文件资源管理器视图（可能有多个拆分窗口） */
	private getExplorerViews(): FileExplorerView[] {
		const views: FileExplorerView[] = [];
		// 优先：内部插件实例（Files Progress 同款方式，最可靠）
		const internal = (this.app as unknown as {
			internalPlugins?: { plugins?: Record<string, { instance?: FileExplorerView }> };
		}).internalPlugins;
		const instance = internal?.plugins?.['file-explorer']?.instance;
		if (instance) views.push(instance);
		// 回退：工作区叶子节点（多窗口场景）
		this.app.workspace.getLeavesOfType('file-explorer').forEach((leaf) => {
			const view = leaf.view as unknown as FileExplorerView;
			if (view && !views.includes(view)) views.push(view);
		});
		return views;
	}

	/** 全量重建所有文件树的进度条 */
	private refreshAll() {
		for (const view of this.getExplorerViews()) {
			this.decorateView(view);
		}
	}

	private decorateView(view: FileExplorerView) {
		const container = view.containerEl;
		if (!container) return;
		// 只处理当前已渲染（可见）的文件标题节点
		container.querySelectorAll<HTMLElement>('.nav-file-title[data-path]').forEach((titleEl) => {
			const path = titleEl.getAttribute('data-path') || '';
			if (path) this.decorateDom(titleEl, path);
		});
	}

	/** 定向刷新单个条目（frontmatter 变化时调用，Files Progress 同款机制） */
	private decoratePath(path: string) {
		for (const view of this.getExplorerViews()) {
			const container = view.containerEl;
			if (!container) continue;
			const titleEl = container.querySelector<HTMLElement>(
				`.nav-file-title[data-path="${CSS.escape(path)}"]`
			);
			if (titleEl) this.decorateDom(titleEl, path);
		}
	}

	/**
	 * 渲染单个条目的进度条。
	 * 所有 .md 条目都渲染（含 0%）；文件夹与其他后缀文件跳过。
	 * 进度条按已读区域分段渲染：每个 range 一段浅色填充。
	 */
	private decorateDom(titleEl: HTMLElement, path: string) {
		// 只处理 .md 与 .pdf 文件：文件夹与其他后缀文件跳过
		if (!path.endsWith('.md') && !path.endsWith('.pdf')) {
			this.removeDecoration(titleEl);
			return;
		}

		// 信息显示：data 属性 + CSS 伪元素（与 novel-word-count 同款机制）。
		// 方案2：RP 接管 ::after，读取 NWC 显示条目组合为 "RP | NWC"
		const infoText = this.buildInfoText(path, titleEl);
		if (!infoText) {
			titleEl.removeAttribute('data-read-progress-info');
		} else {
			titleEl.setAttribute('data-read-progress-info', infoText);
		}

		// Excalidraw 绘图文件：无阅读浓度语义，不渲染下方进度条
		// （阅读时长仍照常计入，info 区仅保留 read time / last read）
		if (this.isExcalidraw(path)) {
			this.removeProgressBar(titleEl);
			return;
		}

		const data = this.progressData[path];
		const percent = this.getProgress(path);
		const total = data?.total ?? 0;
		const ranges = data ? bucketsToRanges(data.buckets, total) : [];

		// 进度条挂在条目节点上（.nav-file-title-content 保持默认 overflow: hidden，
		// 避免破坏文件名随右侧元信息的自动折叠截断）
		const host = titleEl;

		// 已存在则更新，否则新建
		let container = host.querySelector<HTMLElement>(':scope > .explorer-reading-progress-container');
		if (!container) {
			container = host.createDiv({ cls: 'explorer-reading-progress-container' });
		}
		// 跟随文件名正下方：取内容容器相对条目的水平偏移（含层级缩进）
		this.positionBar(container, titleEl);
		// 布局未就绪时 offsetLeft 会读到 0（条目隐藏/批量插入尚未布局），
		// 下一帧复测一次，避免进度条塌到最左侧
		window.requestAnimationFrame(() => {
			if (container?.isConnected) this.positionBar(container, titleEl);
		});
		// 渲染时合并当前计时中的秒数：停留期间浓度渐变实时可见（无需等结算）
		let renderRanges = ranges;
		const timer = this.readTimer;
		if (this.settings.beta && timer && timer.path === path && data && total > 0) {
			// 复制当前桶并增量推进计时中的秒数（不落盘，仅用于渲染预览）
			const preview = data.buckets.slice();
			addToBuckets(preview, total, timer.start, timer.end, timer.credited);
			renderRanges = bucketsToRanges(preview, total);
		}
		this.renderSegments(container, renderRanges, total, percent);
	}

	/**
	 * 定位进度条：left 取文件名内容相对条目的水平偏移（含层级缩进）。
	 * offsetLeft 依赖布局，条目隐藏或批量插入尚未布局时会读到 0，
	 * 导致进度条塌到最左侧。故以 offsetWidth 判断内容是否已完成
	 * 布局：已布局则记录并采用实测值（即使为 0，如顶层条目）；
	 * 未布局则沿用上次有效值，避免把已正确的定位覆盖成 0。
	 */
	private positionBar(container: HTMLElement, titleEl: HTMLElement): void {
		const content = titleEl.querySelector<HTMLElement>(
			'.nav-file-title-content'
		);
		if (content && content.offsetWidth > 0) {
			container.dataset.erpLeft = String(content.offsetLeft);
			container.style.left = `${content.offsetLeft}px`;
		} else {
			container.style.left = `${container.dataset.erpLeft ?? '0'}px`;
		}
	}

	/**
	 * 渲染进度条。
	 * Beta 开启：碎片重叠式分段渲染，每个已读 range → 一个填充段，
	 * 浓度根据阅读时长占目标时长的比例自动适配；达到目标显示达成色。
	 * Beta 关闭：经典单段实心填充（当前位置模式）。
	 */
	private renderSegments(
		container: HTMLElement,
		ranges: Array<[number, number, number]>,
		total: number,
		percent: number
	) {
		// 清空旧分段
		container.empty();
		// 进度条轨道（承载填充段）
		const bar = container.createDiv({ cls: 'explorer-reading-progress-bar' });
		const pending = this.settings.pendingColor;
		const complete = this.settings.completeColor;
		if (this.settings.beta && total > 0) {
			const goal = Math.max(1, this.settings.readGoal * 60);
			for (const [s, e, secs] of ranges) {
				const seg = bar.createDiv({ cls: 'explorer-reading-progress-fill' });
				const left = (s / total) * 100;
				const width = ((e - s) / total) * 100;
				seg.style.left = `${left}%`;
				seg.style.width = `${width}%`;
				// 根据阅读时长自动适配浓度
				seg.style.opacity = String(this.getOpacity(secs));
				// 达到目标时长：显示达成进度条色
				if (secs >= goal) {
					seg.addClass('is-complete');
					if (complete) seg.style.backgroundColor = complete;
				} else if (pending) {
					seg.style.backgroundColor = pending;
				}
			}
		} else {
			// 经典模式：单段实心填充
			const fill = bar.createDiv({ cls: 'explorer-reading-progress-fill' });
			fill.style.width = `${percent}%`;
			if (percent >= 100) {
				fill.addClass('is-complete');
				if (complete) fill.style.backgroundColor = complete;
			} else if (pending) {
				fill.style.backgroundColor = pending;
			}
		}
	}

	// ==================== 信息显示（文件树条目右侧） ====================

	/** 构建信息显示文本（空字符串表示不显示）
	 *  三个槽位（1st/2nd/3rd）按序拼接，槽位间 | 分隔；
	 *  方案2：读取 NWC 的显示条目（data-novel-word-count-plugin），
	 *  组合为 "RP1 | RP2 | RP3 | NWC"——RP 在左、NWC 在右 */
	private buildInfoText(path: string, titleEl: HTMLElement): string {
		const parts: string[] = [];
		for (const type of [
			this.settings.infoDisplay1,
			this.settings.infoDisplay2,
			this.settings.infoDisplay3,
		]) {
			if (type === 'none') continue;
			const text = this.formatInfoSlot(type, path);
			if (text) parts.push(text);
		}
		if (parts.length === 0) return '';
		// 读取 NWC 显示条目并拼接（仅 NWC 启用时：文件树容器带
		// .novel-word-count--active 类；禁用时属性残留但不应显示）
		const nwcActive = titleEl.closest(
			'.novel-word-count--active'
		) !== null;
		const nwc = nwcActive
			? titleEl.getAttribute('data-novel-word-count-plugin')
			: null;
		const rp = parts.join(' | ');
		return nwc ? `${rp} | ${nwc}` : rp;
	}

	/** 渲染单个槽位的信息文本 */
	private formatInfoSlot(type: InfoType, path: string): string {
		// Excalidraw 绘图：无阅读浓度信息 → 隐藏估算时长与阅读进度，
		// 仅保留 read time / last read（阅读时长仍正常计入）
		if (
			this.isExcalidraw(path) &&
			(type === 'esttime' || type === 'progress')
		) {
			return '';
		}
		switch (type) {
			case 'readtime':
				return this.formatReadTime(this.getReadSeconds(path));
			case 'esttime': {
				// 估算分钟数换算为秒，统一由 formatReadTime 处理
				const text = this.formatReadTime(
					Math.round(this.getEstimatedMinutes(path) * 60)
				);
				// 缓存未命中时异步估算，回填后刷新
				if (text === 'unread') void this.ensureEstimated(path);
				return text === 'unread' ? '' : text;
			}
			case 'lastread':
				return this.formatLastRead(path);
			case 'progress':
				return this.formatGoalProgress(path);
		}
	}

	/** 累计阅读秒数（含计时中的秒数，不落盘）
	 *  beta：buckets 存真实秒数；普通模式：buckets 是覆盖标记，
	 *  按覆盖比例 × 文件估算阅读时长折算已阅读时长 */
	private getReadSeconds(path: string): number {
		const data = this.progressData[path];
		if (!data) return 0;
		const timer = this.readTimer;
		// Excalidraw 绘图无阅读浓度信息：无论何种模式，read time 直接取
		// 独立累计的 readSeconds（普通模式的覆盖率×估算对绘图无意义）
		if (this.settings.beta || this.isExcalidraw(path)) {
			// 独立总计时（readSeconds）：仅用于 info display 的
			// read time，与阅读浓度（buckets）完全分离——
			// 不同时段的阅读时长直接相加，不随滚动翻页丢失
			let seconds = data.readSeconds;
			// 计时中的秒数实时反映
			if (timer && timer.path === path) seconds += timer.credited;
			return seconds;
		}
		// 普通模式：已读区域覆盖比例 × 文件估算阅读时长
		let covered = 0;
		for (const v of data.buckets) covered += Math.min(1, v);
		const ratio = Math.min(1, covered / BUCKET_COUNT);
		return Math.round(this.getEstimatedMinutes(path) * 60 * ratio);
	}

	/** 估算阅读时长缓存（path → 分钟），异步回填 */
	private estCache = new Map<string, number>();

	/** 估算阅读时长（分钟，同步查缓存；未缓存返回 0） */
	private getEstimatedMinutes(path: string): number {
		return this.estCache.get(path) ?? 0;
	}
	private async ensureEstimated(path: string): Promise<void> {
		if (this.estCache.has(path)) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		let content = '';
		try {
			content = await this.app.vault.read(file);
		} catch {
			return;
		}
		this.estCache.set(path, this.computeEstimate(content));
		this.schedulePathRefresh(path);
	}

	/** 格式化阅读时长（秒输入）：未阅读 unread，不足 1 分钟 <1m */
	private formatReadTime(seconds: number): string {
		if (seconds <= 0) return 'unread';
		const m = seconds / 60;
		if (m < 1) return '<1m';
		if (m < 60) return `${Math.round(m)}m`;
		const h = Math.floor(m / 60);
		const rem = Math.round(m % 60);
		return rem === 0 ? `${h}h` : `${h}h${rem}m`;
	}

	/** 最近阅读时间：md 用 mtime，PDF 用 progressData 最近写入
	 *  今年内 MM/DD，今年以前 YY/MM/DD */
	private formatLastRead(path: string): string {
		let ts = 0;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			// mtime 是最后修改时间——对 md 而言即最后阅读/编辑时间
			ts = file.stat.mtime;
		}
		if (!ts) return '';
		const d = new Date(ts);
		const now = new Date();
		const mm = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		if (d.getFullYear() === now.getFullYear()) {
			return `${mm}/${dd}`;
		}
		const yy = String(d.getFullYear() % 100).padStart(2, '0');
		return `${yy}/${mm}/${dd}`;
	}

	/** 阅读进度（%）：该篇文件阅读总体进度
	 *  普通：已读区域覆盖比例（与进度条一致）
	 *  Beta：按 prefer time 达成比例加权——
	 *  已达成桶权重 100%（绿色段）；未达成桶按实际阅读
	 *  浓度 secs/prefer time 折算（蓝色段）；未达成按比例扣除 */
	private formatGoalProgress(path: string): string {
		if (!this.settings.beta) {
			return `${this.getProgress(path)}%`;
		}
		const data = this.progressData[path];
		if (!data) return '0%';
		const goalSec = Math.max(1, this.settings.readGoal * 60);
		let weight = 0;
		for (const secs of data.buckets) {
			if (secs >= goalSec) weight += 1;
			else if (secs > 0) weight += secs / goalSec;
		}
		const pct = Math.min(100, Math.round((weight / BUCKET_COUNT) * 100));
		return `${pct}%`;
	}

	/** 移除单个条目的装饰 DOM */
	private removeDecoration(titleEl: HTMLElement) {
		this.removeProgressBar(titleEl);
		titleEl.removeAttribute('data-read-progress-info');
	}

	/** 仅移除下方进度条容器（保留 info 显示） */
	private removeProgressBar(titleEl: HTMLElement) {
		titleEl.querySelectorAll(':scope > .explorer-reading-progress-container').forEach((el) => el.remove());
	}

	/** 是否为 Excalidraw 绘图文件。
	 *  含三类：.excalidraw 后缀、.excalidraw.md 后缀，以及被 Excalidraw
	 *  插件以画板模式打开的普通 .md（frontmatter 标记 excalidraw-plugin
	 *  或 tag excalidraw）。绘图无阅读浓度语义：不显示进度条，
	 *  info 仅保留 read time / last read */
	private isExcalidraw(path: string): boolean {
		if (path.endsWith('.excalidraw.md') || path.endsWith('.excalidraw')) {
			return true;
		}
		// 普通 .md 画板：靠元数据缓存中的 frontmatter / tag 识别
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return false;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return false;
		if (fm['excalidraw-plugin']) return true;
		const tags = fm.tags;
		return Array.isArray(tags) && tags.includes('excalidraw');
	}

	/** 卸载时清理所有装饰 DOM */
	private cleanupDecorations() {
		for (const view of this.getExplorerViews()) {
			const container = view.containerEl;
			if (!container) continue;
			container.querySelectorAll(':scope .explorer-reading-progress-container').forEach((el) => el.remove());
		}
	}

	// ==================== 数据与设置 ====================

	/** 插件数据文件结构（统一存于 data.json） */
	private async loadDataAll(): Promise<{
		settings?: Partial<ExplorerReadingProgressSettings>;
		progress?: Record<string, NoteProgress>;
		positions?: Record<string, number>;
	}> {
		const data = (await this.loadData()) as {
			settings?: Partial<ExplorerReadingProgressSettings>;
			progress?: Record<string, NoteProgress>;
			positions?: Record<string, number>;
		} | null;
		return data ?? {};
	}

	async loadSettings() {
		const data = await this.loadDataAll();
		this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
		// 兼容旧版单槽位 infoDisplay → 迁移到 infoDisplay1
		const legacy = data.settings as
			| { infoDisplay?: InfoType; completeGreen?: boolean }
			| undefined;
		if (legacy?.infoDisplay && this.settings.infoDisplay1 === 'none') {
			this.settings.infoDisplay1 = legacy.infoDisplay;
		}
		// 兼容旧版 completeGreen 开关 → completeColor（默认绿 = 空）
		if (legacy?.completeGreen === true && !this.settings.completeColor) {
			this.settings.completeColor = '';
		}
		// md 笔记上次阅读位置
		this.mdPositions = data.positions ?? {};
		// 兼容旧版数据：纯百分比 / 区间模型 → 桶模型
		this.progressData = {};
		for (const [path, value] of Object.entries(data.progress ?? {})) {
			if (typeof value === 'number') {
				const pct = Math.min(100, Math.max(0, Math.round(value)));
				// 旧版按“阅读次数”记录，迁移时按每次 30s 估算阅读时长
				this.progressData[path] = {
					total: 100,
					buckets: rangesToBuckets(pct > 0 ? [[0, pct, 30]] : [], 100),
					readSeconds: 0,
				};
			} else if (value && typeof value === 'object' && Array.isArray((value as { ranges?: unknown }).ranges)) {
				// 旧版区间模型 → 桶模型
				const old = value as { total?: number; ranges?: Array<[number, number, number]> };
				const total = old.total ?? 100;
				this.progressData[path] = {
					total,
					buckets: rangesToBuckets(old.ranges ?? [], total),
					readSeconds: 0,
				};
			} else if (value && typeof value === 'object' && Array.isArray((value as { buckets?: unknown }).buckets)) {
				// 新版桶模型：直接使用（兼容无 readSeconds 的旧数据）
				this.progressData[path] = {
					...value,
					readSeconds: (value as { readSeconds?: number }).readSeconds ?? 0,
				};
			}
		}
	}

	async saveSettings() {
		await this.saveData({
			settings: this.settings,
			progress: this.progressData,
			positions: this.mdPositions,
		});
	}

	/** 获取系统主题强调色（#rrggbb），供 ColorPicker 初始显示与
	 *  系统滚动渲染渐变取色。
	 *  用临时 DOM 元素计算实际颜色（CSS 变量可能是 var() 引用，
	 *  getComputedStyle 返回原始定义而非计算值） */
	getDefaultAccentColor(): string {
		const probe = document.body.createDiv();
		probe.style.cssText =
			'position:absolute;visibility:hidden;pointer-events:none;' +
			'color:var(--interactive-accent, var(--text-accent, var(--color-accent, #61adff)));';
		const raw = getComputedStyle(probe).color;
		probe.remove();
		// rgb(r, g, b) / rgba(...) → #rrggbb
		const m = raw.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
		if (m) {
			const hex = (n: string) =>
				parseInt(n, 10).toString(16).padStart(2, '0');
			return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
		}
		return '#61adff';
	}

	/** 应用进度条尺寸与偏移（body 级 CSS 变量，Files Progress 同款机制）
	 *  所有条目共享同一变量，确保线宽绝对一致 */
	applyBarStyle() {
		document.body.style.setProperty('--erp-bar-width', `${this.settings.barWidth}px`);
		document.body.style.setProperty('--erp-line-width', `${this.settings.lineWidth}px`);
		document.body.style.setProperty('--erp-bar-offset', `${this.settings.barOffset}px`);
		// 圆角/直角全局切换
		document.body.toggleClass('erp-rounded', this.settings.rounded);
	}

	/** 设置变化后重渲染 */
	settingsChanged() {
		this.applyBarStyle();
		this.refreshAll();
		// 系统滚动渲染：开关变化时挂载/卸载当前视图
		if (this.settings.beta && this.settings.systemScrollRendering) {
			this.attachSystemScrollTrack();
		} else {
			this.detachSystemScrollTrack();
		}
		// Show Content：开关变化时挂载/卸载触发监听
		if (this.settings.showContent) {
			this.attachShowContent();
		} else {
			this.detachShowContent();
		}
	}
}

/** PluginManifest 的最小形状，避免引入未公开的完整类型 */
interface PluginManifestLike {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	author: string;
	isDesktopOnly?: boolean;
}

/** 插件设置面板 */
class ExplorerReadingProgressSettingTab extends PluginSettingTab {
	plugin: ExplorerReadingProgressPlugin;

	constructor(app: App, plugin: ExplorerReadingProgressPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 顶部操作栏：左侧 Back 返回第三方插件目录页，
		// 右侧 Star on Github / Report Issues 跳转插件 GitHub 页面
		const headerRow = containerEl.createDiv({ cls: 'erp-settings-header' });
		const backBtn = headerRow.createEl('button', {
			cls: 'mod-back',
			text: 'Back',
		});
		backBtn.onclick = () => {
			// 打开第三方插件设置页，并恢复到之前滚动位置（Read Progress 条目所在处）
			// 注意：滚动位置记录/恢复方法定义在 Plugin 类上，需通过 this.plugin 调用
			this.app.setting.openTabById('community-plugins');
			// DOM 渲染完成后恢复滚动位置
			window.setTimeout(() => this.plugin.restoreCommunityPluginsScroll(), 50);
		};
		// 右侧操作按钮组
		const actionsEl = headerRow.createDiv({ cls: 'erp-settings-actions' });
		const starBtn = actionsEl.createEl('button', {
			cls: 'erp-action-btn',
			text: '⭐️ Star on Github',
		});
		starBtn.onclick = () => {
			window.open(
				'https://github.com/Losecloud/Obsidian-Read-Progress',
				'_blank'
			);
		};
		const issuesBtn = actionsEl.createEl('button', {
			cls: 'erp-action-btn',
			text: '❓ Report Issues',
		});
		issuesBtn.onclick = () => {
			window.open(
				'https://github.com/Losecloud/Obsidian-Read-Progress/issues',
				'_blank'
			);
		};

		// Time Counting Mode (Beta)：覆盖模型开关（置于顶部）
		new Setting(containerEl)
			.setName('Time Counting Mode (Beta)')
			.setDesc('Track actually read regions with time: re-read areas appear denser, instead of the current cursor position. If you merely want to check the position progress of each note, please switch off this button.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.beta)
					.onChange(async (value) => {
						this.plugin.settings.beta = value;
						await this.plugin.saveSettings();
						this.plugin.settingsChanged();
						// 重渲染设置页以展开/收起 Beta 选项
						this.display();
					})
			);

		// Beta 选项：阅读目标时长
		if (this.plugin.settings.beta) {
			new Setting(containerEl)
				.setName('How long do you prefer reading?')
				.setDesc('Reading goal in minutes (e.g. 120 = 2h). Regions read up to the goal scale density automatically; beyond it, the segment turns into the complete color.')
				.addText((text) =>
					text
						.setValue(String(this.plugin.settings.readGoal))
						.onChange(async (value) => {
							const n = parseInt(value, 10);
							if (Number.isFinite(n) && n > 0) {
								this.plugin.settings.readGoal = n;
								await this.plugin.saveSettings();
								this.plugin.settingsChanged();
							}
						})
				);

			// Beta 选项：系统滚动渲染（仅桌面端：移动端滚动条为系统 overlay，
			// ::-webkit-scrollbar-track 染色无效，故移动端置灰并强制显示为关）
			const sysSupported = this.plugin.isSystemScrollSupported();
			const sysScrollSetting = new Setting(containerEl)
				.setName('System scroll rendering')
				.setDesc(
					sysSupported
						? 'Render reading density into the background track of the right-side system scrollbar of the current note, so you can see which parts are read and which are unread at a glance.'
						: 'Render reading density into the background track of the right-side system scrollbar of the current note. Desktop only — mobile scrollbars are system overlays and cannot be styled.'
				)
				.addToggle((toggle) => {
					toggle
						.setValue(
							sysSupported &&
								this.plugin.settings.systemScrollRendering
						)
						.onChange(async (value) => {
							this.plugin.settings.systemScrollRendering = value;
							await this.plugin.saveSettings();
							this.plugin.settingsChanged();
							// 关闭时子选项灰色禁用
							setSysOptsDisabled(!value);
						});
					if (!sysSupported) toggle.setDisabled(true);
				});

			// 系统滚动渲染子选项：Opacity / LineWidth / Position 横向排布
			const sysOptsRow = sysScrollSetting.infoEl.createDiv({
				cls: 'erp-sys-scroll-opts'
			});
			/** 子选项禁用/启用（开关关闭时灰色禁用） */
			const setSysOptsDisabled = (disabled: boolean): void => {
				sysOptsRow.toggleClass('is-disabled', disabled);
				sysOptsRow
					.querySelectorAll<
						HTMLInputElement | HTMLSelectElement
					>('input, select')
					.forEach((el) => {
						el.disabled = disabled;
					});
			};
			// Opacity：浓度不透明度（0~1）
			sysOptsRow.createSpan({ cls: 'erp-sys-opt-label', text: 'Opacity' });
			sysOptsRow.createEl('input', {
				cls: 'erp-sys-opt-input',
				attr: { type: 'text', value: String(this.plugin.settings.sysScrollOpacity) }
			}).addEventListener('change', async (ev) => {
				const n = parseFloat((ev.target as HTMLInputElement).value);
				if (Number.isFinite(n) && n >= 0 && n <= 1) {
					this.plugin.settings.sysScrollOpacity = n;
					await this.plugin.saveSettings();
					this.plugin.settingsChanged();
				}
			});
			// Line width：线宽（px，超过滚动条宽度则填满）
			sysOptsRow.createSpan({ cls: 'erp-sys-opt-label', text: 'Line width' });
			sysOptsRow.createEl('input', {
				cls: 'erp-sys-opt-input',
				attr: { type: 'text', value: String(this.plugin.settings.sysScrollLineWidth) }
			}).addEventListener('change', async (ev) => {
				const n = parseInt((ev.target as HTMLInputElement).value, 10);
				if (Number.isFinite(n) && n > 0) {
					this.plugin.settings.sysScrollLineWidth = n;
					await this.plugin.saveSettings();
					this.plugin.settingsChanged();
				}
			});
			// Position：左对齐 / 右对齐
			sysOptsRow.createSpan({ cls: 'erp-sys-opt-label', text: 'Position' });
			const posSelect = sysOptsRow.createEl('select', {
				cls: 'erp-sys-opt-input'
			});
			posSelect.createEl('option', { text: 'Left', attr: { value: 'left' } });
			posSelect.createEl('option', { text: 'Right', attr: { value: 'right' } });
			posSelect.value = this.plugin.settings.sysScrollPosition;
			posSelect.addEventListener('change', async (ev) => {
				const v = (ev.target as HTMLSelectElement).value;
				this.plugin.settings.sysScrollPosition =
					v === 'right' ? 'right' : 'left';
				await this.plugin.saveSettings();
				this.plugin.settingsChanged();
			});
			// 初始禁用状态（移动端不支持时整体禁用）
			setSysOptsDisabled(
				!sysSupported ||
					!this.plugin.settings.systemScrollRendering
			);

			// Beta 选项：Show Content（悬浮目录侧边栏）
			new Setting(containerEl)
				.setName('Show Content')
				.setDesc('Hover the left padding area of the note (cm-scroller, non-text zone) to fade in a sidebar with the structured outline of the current note. The current reading heading is highlighted; click any heading to jump.')
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.showContent)
						.onChange(async (value) => {
							this.plugin.settings.showContent = value;
							await this.plugin.saveSettings();
							this.plugin.settingsChanged();
						})
				);
		}

		// Restore Markdown Position：再次打开 md 时恢复上次阅读位置
		new Setting(containerEl)
			.setName('Restore Markdown Position')
			.setDesc('Remember the last reading position of each markdown note and restore it when reopening (like the built-in PDF viewer).')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.restoreMdPosition)
					.onChange(async (value) => {
						this.plugin.settings.restoreMdPosition = value;
						await this.plugin.saveSettings();
					})
			);

		// Info Display：文件树条目右侧信息显示（3 个槽位，互斥）
		const infoOptions: Array<[string, string]> = [
			['none', 'None'],
			['readtime', 'Read Time (actual)'],
			['esttime', 'Est. Time (by words)'],
			['lastread', 'Last Read (date)'],
			['progress', 'Read Progress (% of goal)'],
		];
		const slots: Array<[string, keyof ExplorerReadingProgressSettings]> = [
			['1st Info Display', 'infoDisplay1'],
			['2nd Info Display', 'infoDisplay2'],
			['3rd Info Display', 'infoDisplay3'],
		];
		for (const [label, key] of slots) {
			new Setting(containerEl)
				.setName(label)
				.setDesc(
					label === '1st Info Display'
						? 'Extra info shown at the right side of each file in the explorer (compatible with Novel word count). Slots are exclusive.'
						: 'Additional info slot (excludes types already selected above).'
				)
				.addDropdown((dropdown) => {
					const selected = new Set<InfoType>();
					for (const [, k] of slots) {
						const v = this.plugin.settings[k] as InfoType;
						if (v !== 'none') selected.add(v);
					}
					for (const [value, label] of infoOptions) {
						// 排除其他槽位已选类型（当前槽位保留自身值）
						const isOtherSlot =
							selected.has(value as InfoType) &&
							(this.plugin.settings[key] as InfoType) !== value;
						if (!isOtherSlot) {
							dropdown.addOption(value, label);
						}
					}
					dropdown
						.setValue(this.plugin.settings[key] as InfoType)
						.onChange(async (value) => {
							this.plugin.settings[key] = value as InfoType;
							await this.plugin.saveSettings();
							this.plugin.settingsChanged();
						});
				});
		}

		new Setting(containerEl)
			.setName('Bar width')
			.setDesc('Width of the progress bar in the file explorer (px).')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.barWidth))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.barWidth = n;
							await this.plugin.saveSettings();
							this.plugin.settingsChanged();
						}
					})
			);

		new Setting(containerEl)
			.setName('Line width')
			.setDesc('Thickness (height) of the progress bar line (px).')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.lineWidth))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.lineWidth = n;
							await this.plugin.saveSettings();
							this.plugin.settingsChanged();
						}
					})
			);

		containerEl.createDiv({
			cls: 'setting-item-description erp-note',
			text: 'Note: system scale up >100% will affect rendering precision, please avoid these scale settings for now.',
		});

		new Setting(containerEl)
			.setName('Rounded corners')
			.setDesc('Show fully rounded (pill-shaped) progress bar ends.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.rounded)
					.onChange(async (value) => {
						this.plugin.settings.rounded = value;
						await this.plugin.saveSettings();
						this.plugin.settingsChanged();
					})
			);

		new Setting(containerEl)
			.setName('Vertical offset')
			.setDesc('Vertical offset (px) of the progress bar below the item text.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.barOffset))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (Number.isFinite(n) && n >= 0) {
							this.plugin.settings.barOffset = n;
							await this.plugin.saveSettings();
							this.plugin.settingsChanged();
						}
					})
			);

		// Pending color：进行中填充色（默认系统主题色）
		new Setting(containerEl)
			.setName('Pending color')
			.setDesc('Fill color while reading is in progress. Empty = system accent color.')
			.addColorPicker((picker) =>
				picker
					.setValue(
						this.plugin.settings.pendingColor ||
							this.plugin.getDefaultAccentColor()
					)
					.onChange(async (value) => {
						this.plugin.settings.pendingColor = value;
						await this.plugin.saveSettings();
						this.plugin.settingsChanged();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon('reset')
					.setTooltip('Reset to system accent color')
					.onClick(async () => {
						this.plugin.settings.pendingColor = '';
						await this.plugin.saveSettings();
						this.plugin.settingsChanged();
						this.display();
					})
			);

		// Complete color：完成填充色（默认绿色）
		new Setting(containerEl)
			.setName('Complete color')
			.setDesc('Fill color when reading reaches the goal. Empty = green.')
			.addColorPicker((picker) =>
				picker
					.setValue(
						this.plugin.settings.completeColor || '#4caf50'
					)
					.onChange(async (value) => {
						this.plugin.settings.completeColor = value;
						await this.plugin.saveSettings();
						this.plugin.settingsChanged();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon('reset')
					.setTooltip('Reset to green')
					.onClick(async () => {
						this.plugin.settings.completeColor = '';
						await this.plugin.saveSettings();
						this.plugin.settingsChanged();
						this.display();
					})
			);
	}

}

/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Re-enable rules at end of file; entire file needed them disabled for internal Obsidian field access */
