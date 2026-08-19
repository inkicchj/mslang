/**
 * numbering.js — 显式编号提取（章节引用 @ref 用），纯工具模块。
 * Semantic 与 Builtin 共用；不依赖其它模块。
 */

// 数字层级（1.1.2）与中文编号（第一章 / 一、 / （一））
const RE_NUM_ARABIC = /^(\d+(?:\.\d+)*)/;
const RE_NUM_CN = /^(第[一二三四五六七八九十百]+[章节篇]|[一二三四五六七八九十百]+[、．.]|（[一二三四五六七八九十百]+）|\([一二三四五六七八九十百]+\))/;

/**
 * 从标题文本开头提取显式编号。
 * @param {string} text
 * @param {string} mode - '1' 数字编号 / '一' 中文编号
 * @returns {string|undefined} 提取到的编号（剥离尾随顿号/点），未匹配返回 undefined
 */
export function extractHeadingNumber(text, mode) {
  if (mode !== '1' && mode !== '一') return undefined;
  const re = mode === '1' ? RE_NUM_ARABIC : RE_NUM_CN;
  const m = text.match(re);
  if (!m) return undefined;
  let num = m[1];
  if (mode === '一') num = num.replace(/[、．.]+$/, '');
  return num;
}
