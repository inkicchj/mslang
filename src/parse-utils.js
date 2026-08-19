/**
 * parse-utils.js — 短文本行内解析工具（独立模块，依赖 Lexer/Parser）。
 * normalize / renderer 共用；避免这些模块直接反向操作 Parser 内部。
 */

import { Lexer } from './lexer.js';
import { Parser } from './parser.js';

/**
 * 将短文本解析为行内节点数组（表格单元格 / 宏展开等共用）。
 * O(n) 单次解析：独立 Parser 实例，只取块的 content，不做 normalize。
 * @param {string} text
 * @returns {import('./nodes.js').InlineNode[]}
 */
export function parseInlineFragment(text) {
  const parser = new Parser();
  const doc = parser.parseRaw(new Lexer(text).tokenize(), text);
  return doc.blocks.flatMap((b) => b.content || []);
}
