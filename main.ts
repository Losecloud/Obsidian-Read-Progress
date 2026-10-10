/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- 访问 Obsidian 内部字段（view.editor.cm / app.internalPlugins / leaf.view）与 data.json 解析的必要断言 */
import {
	App,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	debounce,
	TFile,
} from 'obsidian';
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

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
	/** 进度达到 100% 时进度条自动变绿色 */
	completeGreen: boolean;
	/** Beta：启用覆盖模型（记录真实阅读区域，分段渲染）。默认关闭 = 当前位置模式 */
	beta: boolean;
	/** Beta：阅读目标时长（分钟）。区域阅读时长达到该值时显示达成色，浓度按 0~目标自动适配 */
	readGoal: number;
}

const DEFAULT_SETTINGS: ExplorerReadingProgressSettings = {
	barWidth: 90,
	lineWidth: 2,
	barOffset: 5,
	rounded: false,
	completeGreen: true,
	beta: false,
	readGoal: 120,
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
}

/** 初始化空桶 */
function createBuckets(): number[] {
	return new Array(BUCKET_COUNT).fill(0);
}

/**
 * 向桶模型增量加入阅读时长（散点叠加式渐进染色）。
 * 视口覆盖的桶每个 += step：散点叠加是增进的，
 * 连续阅读时相邻桶浓度相近，渲染时自然合并为一段，无割裂。
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
		buckets[i] += seconds;
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

export default class ReadProgressPlugin extends Plugin {
	settings: ExplorerReadingProgressSettings = DEFAULT_SETTINGS;

	/** 滚动事件防抖（300ms） */
	private debouncedSave: ReturnType<typeof debounce>;
	/** 文件树全量刷新防抖（150ms） */
	private scheduleRefresh: ReturnType<typeof debounce>;
	/** 文件树单条目定向刷新防抖（150ms） */
	private schedulePathRefresh: ReturnType<typeof debounce>;
	/** 上一次写入的进度，用于跳过无变化的写入 */
	private lastWritten: Map<string, string> = new Map();
	/** 当前滚动监听的绑定信息，用于卸载时移除 */
	private scrollBinding: { target: HTMLElement; listener: () => void; path: string } | null = null;
	/** 进度数据：路径 → 覆盖模型（统一存于 data.json） */
	private progressData: Record<string, NoteProgress> = {};
	/** 阅读计时状态：当前停留区域（微信读书式计时，翻页/切页时结算） */
	private readTimer: {
		path: string;
		start: number;
		end: number;
		total: number;
		credited: number;
	} | null = null;
	/** 最后一次键鼠操作时间戳（防 idle：5min 无操作才封顶） */
	private lastInputTs: number = Date.now();
	/** 社区插件页滚动位置（Back 按钮返回时恢复，避免回到列表顶部） */
	private communityScrollTop = 0;
	/** 设置页 DOM 监测器（社区插件列表出现时附加滚动监听） */
	private settingObserver: MutationObserver | null = null;

	constructor(app: App, manifest: PluginManifestLike) {
		super(app, manifest);
		// 300ms 防抖：滚动停止后才写入数据文件
		this.debouncedSave = debounce((file: TFile, top: number, vh: number, total: number) => {
			void this.writeProgress(file, top, vh, total);
		}, 300, true);
		// 150ms 防抖：合并文件树刷新，避免高频重渲染
		this.scheduleRefresh = debounce(() => this.refreshAll(), 150, true);
		this.schedulePathRefresh = debounce((path: string) => this.decoratePath(path), 150, true);
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
			})
		);

		// frontmatter 变化 → 定向刷新对应条目（Files Progress 同款机制）
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.schedulePathRefresh(file.path);
				}
			})
		);
		// 删除/重命名 → 全量重建
		this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh()));

		// 布局变化（折叠/展开文件夹、切换仓库视图、新建拆分窗口）→ 全量刷新
		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.scheduleRefresh())
		);
		// 主题切换 → 重渲染（进度条颜色适配亮色/暗色）
		this.registerEvent(
			this.app.workspace.on('css-change', () => this.scheduleRefresh())
		);

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
		// 焦点切出 Obsidian 窗口 → 暂停计时（不清空；聚焦后 tick 验证仍在原区域即自动恢复，无需滚动）
		this.registerDomEvent(window, 'blur', () => {
			this.debugLog('timer paused: window blur');
		});

		this.app.workspace.onLayoutReady(() => {
			this.attachScrollListener();
			// 文件树可能尚未渲染完成，延迟多次扫描确保所有条目就绪
			const delays = [300, 800, 1500, 3000];
			for (const d of delays) {
				window.setTimeout(() => {
					this.scanVault();
					this.scheduleRefresh();
				}, d);
			}
		});
	}

	onunload() {
		// 结算阅读时长并停止滚动监听
		this.settleReadTimer();
		this.detachScrollListener();
		this.debouncedSave.cancel();
		// 断开设置页监测器
		this.settingObserver?.disconnect();
		this.settingObserver = null;
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

	// ==================== 模块1：滚动进度采集 ====================

	/** 给当前激活的 Markdown 视图挂载滚动监听 */
	private attachScrollListener() {
		this.detachScrollListener();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const file = view.file;
		if (!file || file.extension !== 'md') return;

		// 阅读视图（preview）与实时预览（source）都采集
		const viewMode = view.getMode();
		if (viewMode !== 'preview' && viewMode !== 'source') return;

		const scrollEl = this.getScrollTarget(view);
		if (!scrollEl) return;

		const listener = () => {
			const info = this.getScrollInfo(scrollEl);
			if (!info) return;
			const { top, height: total, clientHeight: vh } = info;
			// 用区间指纹跳过无变化的写入（避免频繁写盘）
			const key = `${top.toFixed(1)}|${vh.toFixed(1)}|${total.toFixed(1)}`;
			if (this.lastWritten.get(file.path) === key) return;
			this.lastWritten.set(file.path, key);
			this.debouncedSave(file, top, vh, total);
		};

		scrollEl.addEventListener('scroll', listener);
		// 挂载后立即采集一次（记录当前位置）
		listener();
		this.scrollBinding = { target: scrollEl, listener, path: file.path };
	}

	/** 移除滚动监听（切换笔记时调用，同时结算阅读时长） */
	private detachScrollListener() {
		if (this.scrollBinding) {
			this.scrollBinding.target.removeEventListener('scroll', this.scrollBinding.listener);
			this.scrollBinding = null;
		}
		// 切到其他笔记/非正文页：结算当前区域阅读时长
		this.settleReadTimer();
	}

	/**
	 * 获取滚动目标元素。
	 * 阅读视图：previewMode.containerEl；实时预览：editor.cm.scrollDOM。
	 */
	private getScrollTarget(view: MarkdownView): HTMLElement | null {
		if (view.getMode() === 'preview') {
			return view.previewMode?.containerEl ?? null;
		}
		// 实时预览：通过 editor.cm 访问 CodeMirror 6（非公开字段）
		const cm = (view.editor as unknown as { cm?: { scrollDOM?: HTMLElement } })?.cm;
		return cm?.scrollDOM ?? null;
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
		total: number
	): Promise<void> {
		if (total <= 0 || vh <= 0) return;
		const existing = this.progressData[file.path] ?? { total, buckets: createBuckets() };
		// 更新文档总高度
		existing.total = Math.max(existing.total, total);
		// 计算当前可见区域
		const start = Math.max(0, top);
		const end = Math.min(existing.total, top + vh);
		if (this.settings.beta) {
			// 覆盖模型：不写入 0 秒区域（只在结算时记录实际阅读时长），
			// 滚动停止 → 结算旧区域并开始新计时
			this.startReadTimer(file.path, start, end, existing.total);
		} else {
			// 当前位置模式：从顶部到当前位置
			addToBuckets(existing.buckets, existing.total, 0, end, 1);
		}
		this.progressData[file.path] = existing;
		await this.saveSettings();
		// 定向刷新该条目
		this.schedulePathRefresh(file.path);
	}

	// ==================== 阅读时长计时（微信读书式） ====================

	/** 调试日志：DEBUG_MODE 开启时输出到 console（内部开关，不暴露给用户） */
	private debugLog(...args: unknown[]): void {
		if (DEBUG_MODE) {
			const log = console.log;
			log('[ReadProgress]', ...args);
		}
	}

	/**
	 * 开始新区域计时。
	 * 滚动停止（防抖）后由 writeProgress 调用。
	 * 同一笔记同一区域（±50px）：保留已累计秒数——缓慢滚动不重置计时，
	 * 否则秒数永远累不到目标时长，进度条不变绿。
	 * 区域变化（>50px）：先结算旧区域，再开始新计时。
	 */
	private startReadTimer(path: number | string, start: number, end: number, total: number): void {
		const timer = this.readTimer;
		if (timer && timer.path === path && Math.abs(timer.start - start) <= 50) {
			// 同一区域：保留累计秒数，仅更新视口边界
			timer.start = start;
			timer.end = end;
			timer.total = total;
			return;
		}
		// 区域变化：结算旧区域，开始新计时
		this.settleReadTimer();
		this.readTimer = { path: path as string, start, end, total, credited: 0 };
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
		const existing = this.progressData[timer.path] ?? { total: timer.total, buckets: createBuckets() };
		existing.total = Math.max(existing.total, timer.total);
		addToBuckets(existing.buckets, existing.total, timer.start, timer.end, timer.credited);
		this.progressData[timer.path] = existing;
		this.debugLog('timer settled:', timer.path, `${timer.credited}s`);
		void this.saveSettings();
		this.schedulePathRefresh(timer.path);
	}

	/**
	 * 阅读计时心跳（每秒）。
	 * 以下情况不计时（微信读书规则）：
	 *  - 息屏/锁屏/切后台（document.hidden）
	 *  - 焦点不在 Obsidian 窗口（失焦，聚焦后自动恢复）
	 *  - 打开可见模态框（设置页、命令面板等非正文页）
	 *  - 快速乱翻（滚动位置偏离计时区域 > 50px）
	 *  - 防 idle：持续 5min 无任何键鼠操作才封顶（有操作即顺延）
	 *  - 切换到其他笔记（结算并停止计时）
	 */
	private tickReadTimer(): void {
		const timer = this.readTimer;
		if (!timer) return;
		if (document.hidden) { this.debugLog('timer paused: page hidden'); return; }
		if (!document.hasFocus()) { this.debugLog('timer paused: window not focused'); return; }
		const modal = document.querySelector<HTMLElement>('.modal-container');
		// 只把可见的模态框视为非正文页（隐藏的 suggest 残留在 DOM 中不应暂停计时）
		if (modal && modal.getClientRects().length > 0) { this.debugLog('timer paused: modal open'); return; }
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file || view.file.path !== timer.path) {
			this.debugLog('timer paused: note switched');
			this.settleReadTimer();
			return;
		}
		const scrollEl = this.getScrollTarget(view);
		if (scrollEl && Math.abs(scrollEl.scrollTop - timer.start) > 50) {
			this.debugLog('timer paused: scrolled away from timed region');
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
		if (timer.credited % 5 === 0) this.schedulePathRefresh(timer.path);
	}

	/** 启动时预扫描：进度数据已在 loadSettings 加载，这里仅重渲染已就绪的文件树节点
	 *  （一次遍历所有已渲染节点，替代逐文件 querySelector，避免长时间阻塞） */
	private scanVault() {
		this.refreshAll();
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
		// 只处理 .md 文件：文件夹与其他后缀文件跳过
		if (!path.endsWith('.md')) {
			this.removeDecoration(titleEl);
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
		const content = titleEl.querySelector<HTMLElement>('.nav-file-title-content');
		container.style.left = `${content?.offsetLeft ?? 0}px`;
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
				if (this.settings.completeGreen && secs >= goal) seg.addClass('is-complete');
			}
		} else {
			// 经典模式：单段实心填充
			const fill = bar.createDiv({ cls: 'explorer-reading-progress-fill' });
			fill.style.width = `${percent}%`;
			if (this.settings.completeGreen && percent >= 100) fill.addClass('is-complete');
		}
	}

	/** 移除单个条目的装饰 DOM */
	private removeDecoration(titleEl: HTMLElement) {
		titleEl.querySelectorAll(':scope > .explorer-reading-progress-container').forEach((el) => el.remove());
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
	}> {
		const data = (await this.loadData()) as {
			settings?: Partial<ExplorerReadingProgressSettings>;
			progress?: Record<string, NoteProgress>;
		} | null;
		return data ?? {};
	}

	async loadSettings() {
		const data = await this.loadDataAll();
		this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
		// 兼容旧版数据：纯百分比 / 区间模型 → 桶模型
		this.progressData = {};
		for (const [path, value] of Object.entries(data.progress ?? {})) {
			if (typeof value === 'number') {
				const pct = Math.min(100, Math.max(0, Math.round(value)));
				// 旧版按“阅读次数”记录，迁移时按每次 30s 估算阅读时长
				this.progressData[path] = {
					total: 100,
					buckets: rangesToBuckets(pct > 0 ? [[0, pct, 30]] : [], 100),
				};
			} else if (value && typeof value === 'object' && Array.isArray((value as { ranges?: unknown }).ranges)) {
				// 旧版区间模型 → 桶模型
				const old = value as { total?: number; ranges?: Array<[number, number, number]> };
				const total = old.total ?? 100;
				this.progressData[path] = {
					total,
					buckets: rangesToBuckets(old.ranges ?? [], total),
				};
			} else if (value && typeof value === 'object' && Array.isArray((value as { buckets?: unknown }).buckets)) {
				// 新版桶模型：直接使用
				this.progressData[path] = value;
			}
		}
	}

	async saveSettings() {
		await this.saveData({
			settings: this.settings,
			progress: this.progressData,
		});
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

		// 返回第三方插件目录页
		const backBtn = containerEl.createEl('button', {
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

		// Time Counting Mode (Beta)：覆盖模型开关（置于顶部）
		new Setting(containerEl)
			.setName('Time Counting Mode (Beta)')
			.setDesc('Track actually read regions with time: re-read areas appear denser, instead of the current cursor position.')
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

		new Setting(containerEl)
			.setName('Green on complete')
			.setDesc('Turn the progress bar green when reading reaches 100%.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.completeGreen)
					.onChange(async (value) => {
						this.plugin.settings.completeGreen = value;
						await this.plugin.saveSettings();
						this.plugin.settingsChanged();
					})
			);
	}
}
