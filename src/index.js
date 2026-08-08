/**
 * mslang-js — A Lightweight Markup Language (JavaScript)
 *
 * 类似于 Markdown 的轻量级排版语言，完整实现了：
 *   词法解析器 (Lexer) → 语法解析器 (Parser) → 渲染引擎 (Renderer)
 *
 * 使用:
 *
 *   // ES Module
 *   import { HTMLRenderer, Parser, Lexer } from 'mslang';
 *
 *   // 渲染
 *   const renderer = new HTMLRenderer();
 *   renderer.addFunction('greet', (name) => `<b>Hello, ${name}!</b>`);
 *   const html = renderer.render('# Hello @greet("World")');
 *
 *   // 仅解析为 AST
 *   const parser = new Parser();
 *   const ast = parser.parseText('# Hello **World**');
 *   console.log(ast);
 *
 *   // 表达式：逻辑运算、文献/术语引用（数据经 render 注入）
 *   const html2 = renderer.render('@if(has_cite("doe2020"), cite("doe2020"), "（待补充）")', {
 *     data: { bibliography: { doe2020: { number: 1 } } },
 *   });
 *
 *   // Token 流
 *   const lexer = new Lexer('# Hello');
 *   const tokens = lexer.tokenize();
 */

import { Lexer, LexerError } from './lexer.js';
import { Parser, ParserError, dumpAST, mergeDocuments } from './parser.js';
import { HTMLRenderer } from './renderer.js';
import { TokenType, Position, Token, CHAR } from './tokens.js';
import { parseExpression, parseArgs, evaluate, EvalError } from './expression.js';
import {
  Document, Heading, Paragraph, BlockQuote, CodeBlock,
  UnorderedList, OrderedList, ListItem, HorizontalRule,
  AlignBlock, Table,
  RawText, Bold, Italic, Strikethrough, InlineCode,
  Link, Image, FunctionCall, Color,
  Superscript, Subscript, RawHtml, FootnoteRef,
  LineBreak,
} from './nodes.js';

export {
  Lexer, LexerError,
  Parser, ParserError, dumpAST, mergeDocuments,
  HTMLRenderer,
  parseExpression, parseArgs, evaluate, EvalError,
  TokenType, Position, Token, CHAR,
  Document, Heading, Paragraph, BlockQuote, CodeBlock,
  UnorderedList, OrderedList, ListItem, HorizontalRule,
  AlignBlock, Table,
  RawText, Bold, Italic, Strikethrough, InlineCode,
  Link, Image, FunctionCall, Color,
  Superscript, Subscript, RawHtml, FootnoteRef,
  LineBreak,
};

// 便捷函数: 将 mslang 文本直接渲染为 HTML
export function mslangToHTML(source, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.render(source, _renderOptions(options));
}

// 异步版: 支持返回 Promise 的自定义函数（如网络请求），其余语义与 mslangToHTML 相同
export async function mslangToHTMLAsync(source, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.renderAsync(source, _renderOptions(options));
}

// 多文档合并渲染：跨文档连续编号、交叉引用、全局 @set（文档顺序即编号顺序）
export function mslangToHTMLAll(sources, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.renderAll(sources, _renderOptions(options));
}

// 异步版 mslangToHTMLAll，语义与 mslangToHTMLAsync 相同
export async function mslangToHTMLAllAsync(sources, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.renderAllAsync(sources, _renderOptions(options));
}

/** mslangToHTML / mslangToHTMLAsync 共用选项透传 */
function _renderOptions(options) {
  return {
    wrapperClass: options.wrapperClass || 'mslang',
    wrapperId: options.wrapperId || '',
    data: options.data,
    variables: options.variables,
    headingNumbering: options.headingNumbering,
    refNumbering: options.refNumbering,
    captionPrefix: options.captionPrefix,
  };
}
