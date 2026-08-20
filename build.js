/**
 * mslang 构建脚本
 *
 * 使用 esbuild 将 ES 模块打包为浏览器可用的单文件：
 *   - dist/mslang.esm.js    : ES module 格式
 *   - dist/mslang.iife.js   : IIFE 格式，暴露 window.mslang
 *   - dist/mslang.iife.min.js : IIFE 压缩版 (用于 CDN)
 *
 * 用法: node build.js
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

// KaTeX CSS 与 highlight.js github 主题（构建时内联进产物；renderer 按需输出 <style>）
let katexCss = '';
try {
  katexCss = readFileSync('node_modules/katex/dist/katex.min.css', 'utf8');
} catch { /* katex 未安装时跳过 */ }
let highlightCss = '';
try {
  highlightCss = readFileSync('node_modules/highlight.js/styles/github.css', 'utf8');
} catch { /* highlight.js 未安装时跳过 */ }

const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  globalName: 'mslang',
  target: 'es2020',
  define: {
    KATEX_CSS: JSON.stringify(katexCss),
    HIGHLIGHT_CSS: JSON.stringify(highlightCss),
  },
  // Node 内建 'module'（citation.js 用于同步探测 @citation-js）：
  // 浏览器 bundle 中以空桩替换 → createRequire 返回 null → 自动探测回退 lightweight，
  // Node 直连 src 时仍走真实 createRequire（同步探测不变）。
  plugins: [{
    name: 'node-module-stub',
    setup(build) {
      build.onResolve({ filter: /^module$/ }, () => ({ path: 'module', namespace: 'mslang-node-module' }));
      build.onLoad({ filter: /^module$/, namespace: 'mslang-node-module' }, () => ({
        contents: 'export const createRequire = () => null;',
        loader: 'js',
      }));
    },
  }],
  banner: {
    js: `/*! mslang v0.3.0 — Lightweight Academic Markup Language | Apache-2.0 License */`,
  },
  footer: {
    js: `/*! built: ${new Date().toISOString()} */`,
  },
};

// ---- ES Module ----
await esbuild.build({
  ...shared,
  format: 'esm',
  outfile: 'dist/mslang.esm.js',
});

// ---- IIFE ----
await esbuild.build({
  ...shared,
  format: 'iife',
  outfile: 'dist/mslang.iife.js',
});

// ---- IIFE minified ----
await esbuild.build({
  ...shared,
  format: 'iife',
  outfile: 'dist/mslang.iife.min.js',
  minify: true,
});

console.log('✅ Build complete!');
console.log('   dist/mslang.esm.js     — ES module');
console.log('   dist/mslang.iife.js    — IIFE  (window.mslang)');
console.log('   dist/mslang.iife.min.js — IIFE minified');

// Print sizes
for (const f of ['dist/mslang.esm.js', 'dist/mslang.iife.js', 'dist/mslang.iife.min.js']) {
  const buf = readFileSync(f);
  console.log(`   ${f.padEnd(28)} ${(buf.length / 1024).toFixed(1)} KB`);
}
