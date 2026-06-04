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

const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  globalName: 'mslang',
  target: 'es2020',
  banner: {
    js: `/*! mslang v0.1.0 — Lightweight Markup Language | MIT License */`,
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
