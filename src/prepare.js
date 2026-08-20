/**
 * prepare.js — 管线编排（mslang 0.2）：include 展开 → lex → parse → normalize →
 * runtime 应用配置/变量 → 语义分析。供 analyze() 使用（Renderer 内部复用同模块）。
 * 返回 { document, runtime, semantic, issues }（issues 为 include 层诊断）。
 */

import { Lexer } from './lexer.js';
import { Parser, finalizeDocument, mergeDocuments } from './parser.js';
import { RuntimeContext } from './runtime.js';
import { SemanticAnalyzer, eachBlocksInline } from './semantic.js';
import { expandIncludes } from './include.js';
import { applyDocMeta } from './meta.js';
import { FunctionCall, Document } from './nodes.js';

/** 文档配置应用（@set/@let/@define 预扫描；@plugin 属渲染期，analyze 不注册） */
function applyDocConfig(runtime, blocks) {
  eachBlocksInline(blocks, (n) => {
    if (n instanceof FunctionCall) {
      if (n.name === 'set') runtime.applySet(n);
      else if (n.name === 'let') runtime.applyLet(n);
      else if (n.name === 'define') runtime.applyDefine(n);
    }
  });
}

/** 输入收敛为 Stable 前的单文档（字符串经 Raw+finalize，Document 直接用）；含 include 展开 */
function toDocument(source, options, issues) {
  if (source instanceof Document) return source;
  if (typeof source !== 'string') throw new TypeError('prepare 输入须为 string | Document | 数组');
  const parser = new Parser();
  let document = parser.parseRaw(new Lexer(source).tokenize(), source);
  document = finalizeDocument(document, source, document._footnoteDefs, document._footnoteDefPositions);
  return document;
}

/**
 * 完整管线编排。同步 loader 时同步返回；异步 loader（include 返回 Promise）时返回
 * Promise<Prepared>（options.async 需 true）。数组输入 = 多文档合并（跨文档连续编号）。
 */
export function prepare(source, options = {}) {
  const issues = [];
  const run = (effectiveSource) => {
    let document = toDocument(effectiveSource, options, issues);
    const runtime = new RuntimeContext({
      functions: options.functions,
      escapeHtml: options.escapeHtml,
      pretty: options.pretty,
    });
    runtime.resetHost(options);
    applyDocConfig(runtime, document.blocks);
    applyDocMeta(document, runtime, options);
    const semantic = new SemanticAnalyzer({ runtime }).analyze(document);
    return { document, runtime, semantic, issues };
  };
  // 多文档合并：逐文档（含 include 展开）→ mergeDocuments（跨文档连续编号/引用/脚注重排）
  if (Array.isArray(source)) {
    const expandedList = source.map((s) => (typeof s === 'string' && options.include
      ? expandIncludes(s, { include: options.include, issues })
      : s));
    const buildMerged = (list) => mergeDocuments(...list.map((s) => toDocument(s, options, issues)));
    const anyPromise = expandedList.some((x) => x instanceof Promise);
    if (anyPromise) {
      return Promise.all(expandedList).then((list) => run(buildMerged(list)));
    }
    return run(buildMerged(expandedList));
  }
  if (typeof source === 'string' && options.include) {
    const expanded = expandIncludes(source, { include: options.include, issues });
    return expanded instanceof Promise
      ? expanded.then(run)
      : run(expanded);
  }
  return run(source);
}