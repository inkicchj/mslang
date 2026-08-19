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
import { prepare } from './prepare.js';
import { DIAG_ISSUE_TYPE, checkIntegrity } from './semantic.js';

// 公共导出：render/renderAsync（渲染）/ Parser/parse/dumpAST/toJSON（AST）
// analyze（语义 + 诊断）/ BlockEditor（块编辑）/ llmReport（自查文本）
// HTMLRenderer 与 diffBlocks 为内部实现，不导出（render 与 BlockEditor 内部使用）
export {
  Parser, dumpAST, BlockEditor, toJSON, llmReport,
};

/** 解析为 AST（Document）：Token → Raw AST → Stable AST */
export function parse(source, ...args) {
  return new Parser().parseText(String(source), ...args);
}

/**
 * 语义分析入口：include 展开 → parse → normalize → runtime 配置变量 → 语义分析。
 * 返回 { document, semantic, diagnostics }（不渲染 HTML）。
 * @returns {{ document, semantic, diagnostics: Array }}
 */
export function analyze(source, options = {}) {
  const gather = (prepared) => {
    const { document, runtime, semantic, issues } = prepared;
    // include 层 issues（{type,key,count,block}）→ 标准诊断 {code,message,span,data}
    const typeToCode = Object.fromEntries(Object.entries(DIAG_ISSUE_TYPE).map(([c, t]) => [t, c]));
    const includeDiags = issues.map((i) => ({
      code: typeToCode[i.type] || i.type,
      severity: 'warning',
      message: i.key,
      span: undefined,
      data: { label: i.key },
      block: i.block,
      count: i.count,
    }));
    const diagnostics = [...includeDiags, ...checkIntegrity(document, runtime, semantic)];
    return { document, semantic, diagnostics };
  };
  const prepared = prepare(source, options);
  return prepared instanceof Promise ? prepared.then(gather) : gather(prepared);
}

/**
 * 唯一渲染入口（0.2.1：薄 orchestrator）。
 * 解析/规范化/运行时/语义全部在 prepare()（唯一管线）；Renderer 只做 AST→HTML。
 * 数组自动合并；async/blocks 为配置项；完整选项见 mslang.d.ts / overview.md。
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
 * @param {boolean} [options.allowPlugins=false] - 允许 @plugin 文档内插件（默认关闭，文档不可打开）
 * @param {boolean} [options.escapeHtml=true] - 转义 HTML 特殊字符
 * @param {boolean} [options.pretty=false] - 输出换行美化
 * @param {function} [options.mathRenderer] - 公式渲染器（默认内置 KaTeX）
 * @param {string} [options.mathFontsPath] - KaTeX 字体本地托管路径
 * @param {function} [options.codeRenderer] - mermaid 代码块渲染器（默认转义透传）
 * @param {object} [options.functions] - 自定义函数表
 * @param {function} [options.include] - 跨文档引用 loader：@include("path", "part") 时
 *   调用（path）取文档源码；返回 string 同步展开，返回 Promise 需 async: true
 * @returns {string|Promise<string>|{html: string, blockHashes: object}}
 */
export function render(source, options = {}) {
  return new HTMLRenderer(options).render(source, options);
}

/** 显式异步渲染：render(source, { async: true }) 的别名 */
export function renderAsync(source, options = {}) {
  return render(source, { ...options, async: true });
}
