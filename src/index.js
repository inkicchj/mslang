/**
 * mslang-js — A Lightweight Markup Language (JavaScript)
 *
 * 类似于 Markdown 的轻量级排版语言：词法解析 (Lexer) → 语法解析 (Parser) → 渲染 (Renderer)。
 * 主要在前端使用，唯一入口 render()，async/多文档合并/块级渲染均为配置项。
 *
 * 使用:
 *
 *   // 渲染（async: true 时返回 Promise）
 *   import { render } from 'mslang';
 *   const html = render('# Hello @greet("World")', {
 *     functions: { greet: (name) => `<b>Hello, ${name}!</b>` },
 *   });
 *
 *   // 多文档合并：传数组自动合并（跨文档连续编号、交叉引用、全局 @set）
 *   const htmlAll = render(['# 第一篇', '# 第二篇'], { data: {...} });
 *
 *   // 块级渲染：返回 { html, blockHashes }（块级编辑，含 <!--mslang:N--> 哨兵）
 *   const { html, blockHashes } = render(src, { blocks: true });
 *
 *   // 异步渲染（自定义函数返回 Promise，如网络请求）
 *   const htmlAsync = await render(src, { async: true });
 *
 *   // 解析为 AST（块级编辑需要块区间 startPos/endPos/raw 时使用）
 *   const parser = new Parser();
 *   const ast = parser.parseText('# Hello **World**');
 */

import { Parser, dumpAST, mergeDocuments, toJSON } from './parser.js';
import { HTMLRenderer, llmReport } from './renderer.js';
import { BlockEditor } from './blockeditor.js';
import { Document } from './nodes.js';
import { expandIncludes } from './include.js';

// 公共导出：render（唯一入口）/ Parser（AST）/ dumpAST（调试）/ BlockEditor（块编辑）
// toJSON（AST 结构化，LLM 消费）/ llmReport（check issues 文本化，LLM 自查）
// HTMLRenderer 与 diffBlocks 为内部实现，不导出（render 与 BlockEditor 内部使用）
export { Parser, dumpAST, BlockEditor, toJSON, llmReport };

/**
 * mslang 唯一渲染入口。
 * @param {string|string[]|Document} source - 字符串渲染；数组自动合并（多文档连续编号）
 * @param {object} [options]
 * @param {boolean} [options.async=false] - 异步渲染（支持返回 Promise 的自定义函数），返回 Promise<string>
 * @param {boolean} [options.blocks=false] - 块级渲染，返回 { html, blockHashes }（仅单文档）
 * @param {object} [options.data] - 数据（bibliography/terms 等）
 * @param {object} [options.variables] - 变量
 * @param {string} [options.wrapperClass='mslang'] - 外层 div class
 * @param {string} [options.wrapperId=''] - 外层 div id
 * @param {string} [options.headingNumbering] - 标题自动编号（如 '1.1'）
 * @param {string} [options.refNumbering] - @ref 编号提取（如 '1'）
 * @param {object} [options.captionPrefix] - 图/表/公式编号前缀（fig/tbl/eq）
 * @param {string} [options.citeKeyAttr] - 引用 data 属性名（如 'data-cite-key'）
 * @param {string} [options.termKeyAttr] - 术语 data 属性名
 * @param {string} [options.refKeyAttr] - 交叉引用 data 属性名
 * @param {string} [options.citeStyle] - 引用样式：'numeric'（默认）/ 'author-year' / 'author'
 * @param {boolean} [options.allowPlugins=true] - 允许 @plugin 文档内插件
 * @param {boolean} [options.escapeHtml=true] - 转义 HTML 特殊字符
 * @param {boolean} [options.pretty=false] - 输出换行美化
 * @param {function} [options.mathRenderer] - 公式渲染器（默认内置 KaTeX）
 * @param {string} [options.mathFontsPath] - KaTeX 字体本地托管路径
 * @param {function} [options.codeRenderer] - mermaid 代码块渲染器（默认转义透传）
 * @param {object} [options.functions] - 自定义函数表
 * @param {function} [options.include] - 跨文档引用 loader：@include("path", "part") 时
 *   调用（path）取文档源码；返回 string 同步展开，返回 Promise 需 async: true
 * @param {function} [options.include] - 跨文档引用 loader：@include("path", "part") 时
 *   调用（path）取文档源码；返回 string 同步展开，返回 Promise 需 async: true
 * @returns {string|Promise<string>|{html: string, blockHashes: object}}
 */
export function render(source, options = {}) {
  const renderer = new HTMLRenderer(_rendererOpts(options));
  const opts = _renderOptions(options);
  const finish = (s) => {
    if (Array.isArray(s)) {
      // 多文档合并：字符串自动解析，Document 直接使用（跨文档连续编号、交叉引用、全局 @set）
      const docs = s.map(x => x instanceof Document ? x : new Parser().parseText(x));
      return options.async
        ? renderer.renderAllAsync(docs, opts)
        : renderer.renderAll(docs, opts);
    }
    if (options.async) return renderer.renderAsync(s, opts);
    if (options.blocks) return renderer.renderBlocks(s, opts);
    return renderer.render(s, opts);
  };
  const attachPreIssues = (result, preIssues) => {
    if (preIssues && preIssues.length && result && typeof result === 'object'
      && Array.isArray(result.issues)) {
      result.issues = [...preIssues, ...result.issues];
    }
    return result;
  };
  // 跨文档引用：字符串源在 parse 前展开（异步 loader 时预展开先于渲染）
  if (typeof source === 'string' && options.include) {
    const preIssues = [];
    const expanded = expandIncludes(source, { include: options.include, issues: preIssues });
    if (expanded instanceof Promise) {
      return expanded.then((s) => attachPreIssues(finish(s), preIssues));
    }
    return attachPreIssues(finish(expanded), preIssues);
  }
  return finish(source);
}

/** 渲染器构造选项（escapeHtml/pretty 仅构造时生效） */
function _rendererOpts(options) {
  return {
    functions: options.functions,
    escapeHtml: options.escapeHtml,
    pretty: options.pretty,
  };
}

/** render 共用选项透传 */
function _renderOptions(options) {
  return {
    wrapperClass: options.wrapperClass || 'mslang',
    wrapperId: options.wrapperId || '',
    data: options.data,
    variables: options.variables,
    headingNumbering: options.headingNumbering,
    refNumbering: options.refNumbering,
    captionPrefix: options.captionPrefix,
    citeKeyAttr: options.citeKeyAttr,
    termKeyAttr: options.termKeyAttr,
    refKeyAttr: options.refKeyAttr,
    mathRenderer: options.mathRenderer,
    mathFontsPath: options.mathFontsPath,
    codeRenderer: options.codeRenderer,
    check: options.check,
    bibStyle: options.bibStyle,
    blocks: options.blocks,
    citeStyle: options.citeStyle,
    allowPlugins: options.allowPlugins,
    blockMarkers: options.blockMarkers,
  };
}
