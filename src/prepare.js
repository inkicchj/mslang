/**
 * prepare.js — 管线编排（mslang 0.2）：include 展开 → lex → parse → normalize →
 * runtime 应用配置/变量 → 语义分析。供 analyze() 使用（Renderer 内部复用同模块）。
 * 返回 { document, runtime, semantic, issues }（issues 为 include 层诊断）。
 */

import { Lexer } from './lexer.js';
import { Parser, finalizeDocument } from './parser.js';
import { RuntimeContext } from './runtime.js';
import { SemanticAnalyzer, eachBlocksInline } from './semantic.js';
import { expandIncludes } from './include.js';
import { FunctionCall } from './nodes.js';

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

/**
 * 完整管线编排。同步 loader 时同步返回；异步 loader（include 返回 Promise）时返回
 * Promise<Prepared>（options.async 需 true）。
 */
export function prepare(source, options = {}) {
  const issues = [];
  const run = (effectiveSource) => {
    let document;
    if (typeof effectiveSource === 'string') {
      // 唯一管线：Raw 解析 → 单次 normalize/区间/脚注收尾（与其他入口共享 finalizeDocument）
      const parser = new Parser();
      document = finalizeDocument(
        parser.parseRaw(new Lexer(effectiveSource).tokenize(), effectiveSource),
        effectiveSource, parser._footnoteDefs, parser._footnoteDefPositions,
      );
    } else {
      document = effectiveSource;
    }
    const runtime = new RuntimeContext({
      functions: options.functions,
      escapeHtml: options.escapeHtml,
      pretty: options.pretty,
    });
    runtime.resetHost(options);
    applyDocConfig(runtime, document.blocks);
    const semantic = new SemanticAnalyzer({ runtime }).analyze(document);
    return { document, runtime, semantic, issues };
  };
  if (typeof source === 'string' && options.include) {
    const expanded = expandIncludes(source, { include: options.include, issues });
    return expanded instanceof Promise
      ? expanded.then(run)
      : run(expanded);
  }
  return run(source);
}