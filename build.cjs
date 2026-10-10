// 构建脚本：用 Node 内置 stripTypeScriptTypes 把 main.ts 转成 Obsidian 插件所需的 CJS main.js
const { readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');

const dir = __dirname;
const src = readFileSync(path.join(dir, 'main.ts'), 'utf8');

// 1) 剥离 TS 类型（接口、类型别名、类型注解），保留模块语法
let js = stripTypeScriptTypes(src, { mode: 'strip' });

// 2) import { ... } from 'obsidian';  →  const { ... } = require('obsidian');
js = js.replace(
	/import\s*\{([\s\S]*?)\}\s*from\s*['"]obsidian['"];?/,
	(_m, names) => `const {${names}} = require('obsidian');`
);

// 3) export default class X  →  class X
js = js.replace(/export\s+default\s+class\s+/, 'class ');

// 4) 末尾导出（Obsidian 插件入口）
js += '\nmodule.exports = ReadProgressPlugin;\n';

writeFileSync(path.join(dir, 'main.js'), js);
console.log(`main.js built: ${js.length} bytes`);

// 5) 自动部署到 Obsidian 插件目录
// 注意：data.json 是用户阅读进度数据，部署时必须保留（不能随目录删除）
const vaultRoot = path.join(dir, '..');
const target = path.join(vaultRoot, '.obsidian', 'plugins', 'read-progress');
try {
	// 备份 data.json（rmSync 会连同用户数据一起删除）
	const dataPath = path.join(target, 'data.json');
	let savedData = null;
	try {
		savedData = readFileSync(dataPath);
	} catch (_) {
		/* 无旧数据 */
	}
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	copyFileSync(path.join(dir, 'main.js'), path.join(target, 'main.js'));
	copyFileSync(path.join(dir, 'styles.css'), path.join(target, 'styles.css'));
	copyFileSync(path.join(dir, 'manifest.json'), path.join(target, 'manifest.json'));
	if (savedData) writeFileSync(dataPath, savedData);
	console.log(`deployed to: ${target}`);
	console.log('→ 在 Obsidian 中禁用并重新启用 Read Progress 即可检查效果');
} catch (err) {
	console.error('deploy failed:', err.message);
}
