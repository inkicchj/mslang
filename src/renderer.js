/**
 * mslang 渲染引擎 (Renderer) — JavaScript 实现
 *
 * 将 AST 渲染为 HTML。采用 Visitor 模式遍历 AST 树。
 * 输出纯 HTML 片段（无 class 属性），外层包 <div> 便于 CSS 选择器定位。
 */

import {
  Document, Heading, Paragraph, BlockQuote, CodeBlock,
  UnorderedList, OrderedList, ListItem, HorizontalRule,
  RawText, Bold, Italic, Strikethrough, InlineCode,
  Link, Image, LineBreak, FunctionCall, Color,
  Superscript, Subscript, RawHtml, Table, FootnoteRef, AlignBlock,
} from './nodes.js';

import { Lexer } from './lexer.js';
import { Parser } from './parser.js';

// ================================================================
// HTML 转义
// ================================================================

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

const ESC_ATTR_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHTML(text) {
  return text.replace(/[&<>]/g, ch => ESC_MAP[ch] || ch);
}

function escapeAttr(text) {
  return text.replace(/[&<>"']/g, ch => ESC_ATTR_MAP[ch] || ch);
}

// ================================================================
// HTMLRenderer
// ================================================================

class HTMLRenderer {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.pretty=true]
   * @param {boolean} [opts.escapeHtml=true]
   * @param {Object<string, Function>} [opts.functions]
   */
  constructor(opts = {}) {
    this.pretty = opts.pretty !== false;
    this.escapeHtml = opts.escapeHtml !== false;
    this._functions = opts.functions || {};
    this._output = [];
  }

  /**
   * 注册自定义函数
   * @param {string} name
   * @param {Function} func
   */
  addFunction(name, func) {
    this._functions[name] = func;
  }

  /**
   * 渲染为 HTML 片段。
   *
   * @param {string|Document} source - mslang 文本或 Document AST
   * @param {object} [opts]
   * @param {string} [opts.wrapperClass='mslang']
   * @param {string} [opts.wrapperId='']
   * @returns {string}
   */
  render(source, opts = {}) {
    const { wrapperClass = 'mslang', wrapperId = '' } = opts;
    this._output = [];

    let body;
    if (source instanceof Document) {
      source.accept(this);
      body = this._output.join('');
    } else {
      const lexer = new Lexer(source);
      const tokens = lexer.tokenize();
      const ast = new Parser().parse(tokens);
      ast.accept(this);
      body = this._output.join('');
    }

    const cls = wrapperClass ? ` class="${wrapperClass}"` : '';
    const id = wrapperId ? ` id="${wrapperId}"` : '';
    return `<div${cls}${id}>\n${body}\n</div>`;
  }

  // ================================================================
  // Visitor 实现
  // ================================================================

  genericVisit(node) {
    this._write(`<!-- unhandled: ${node.constructor.name} -->`);
  }

  visit_Document(doc) {
    doc.blocks.forEach((block, i) => {
      block.accept(this);
      if (this.pretty && i < doc.blocks.length - 1) this._write('\n');
    });

    // 脚注区域
    if (Object.keys(doc.footnotes).length > 0) {
      if (this.pretty) this._write('\n');
      this._write('<hr>');
      if (this.pretty) this._write('\n');
      this._write('<ol>');
      if (this.pretty) this._write('\n');
      let idx = 0;
      for (const [label, text] of Object.entries(doc.footnotes)) {
        idx++;
        this._write(`<li id="fn-${idx}">${this._esc(text)} ` +
                    `<a href="#fnref-${idx}">&#8617;</a></li>`);
        if (this.pretty) this._write('\n');
      }
      this._write('</ol>');
      if (this.pretty) this._write('\n');
    }
  }

  visit_Heading(node) {
    const tag = `h${Math.min(node.level, 6)}`;
    const idAttr = node.id ? ` id="${node.id}"` : '';
    this._write(`<${tag}${idAttr}>`);
    node.content.forEach(n => n.accept(this));
    this._write(`</${tag}>`);
    if (this.pretty) this._write('\n');
  }

  visit_Paragraph(node) {
    if (node.content.length && node.content.every(n => n instanceof LineBreak)) {
      node.content.forEach(() => {
        this._write('<br>');
        if (this.pretty) this._write('\n');
      });
      return;
    }
    this._write('<p>');
    node.content.forEach(n => n.accept(this));
    this._write('</p>');
    if (this.pretty) this._write('\n');
  }

  visit_BlockQuote(node) {
    this._write('<blockquote>');
    if (this.pretty) this._write('\n');
    node.content.forEach(n => n.accept(this));
    if (this.pretty) this._write('\n');
    this._write('</blockquote>');
    if (this.pretty) this._write('\n');
  }

  visit_CodeBlock(node) {
    const langAttr = node.language ? ` data-language="${this._escAttr(node.language)}"` : '';
    this._write(`<pre${langAttr}><code>`);
    this._write(this._esc(node.code));
    this._write('</code></pre>');
    if (this.pretty) this._write('\n');
  }

  visit_UnorderedList(node) {
    this._write('<ul>');
    if (this.pretty) this._write('\n');
    node.items.forEach(item => item.accept(this));
    this._write('</ul>');
    if (this.pretty) this._write('\n');
  }

  visit_OrderedList(node) {
    this._write('<ol>');
    if (this.pretty) this._write('\n');
    node.items.forEach(item => item.accept(this));
    this._write('</ol>');
    if (this.pretty) this._write('\n');
  }

  visit_ListItem(node) {
    this._write('<li>');
    if (node.checked !== null) {
      const checked = node.checked ? ' checked' : '';
      this._write(`<input type="checkbox" disabled${checked}>`);
      this._write('<label>');
    }
    node.content.forEach(n => n.accept(this));
    node.children.forEach(child => child.accept(this));
    if (node.checked !== null) this._write('</label>');
    this._write('</li>');
    if (this.pretty) this._write('\n');
  }

  visit_HorizontalRule(node) {
    this._write('<hr>');
    if (this.pretty) this._write('\n');
  }

  visit_AlignBlock(node) {
    const style = `text-align:${node.align}`;
    this._write(`<div style="${style}">`);
    node.content.forEach(n => n.accept(this));
    this._write('</div>');
    if (this.pretty) this._write('\n');
  }

  visit_Table(node) {
    this._write('<table>');
    if (this.pretty) this._write('\n');
    if (node.headers.length) {
      this._write('<thead><tr>');
      node.headers.forEach(h => this._write(`<th>${this._esc(h)}</th>`));
      this._write('</tr></thead>');
      if (this.pretty) this._write('\n');
    }
    if (node.rows.length) {
      this._write('<tbody>');
      if (this.pretty) this._write('\n');
      node.rows.forEach(row => {
        this._write('<tr>');
        row.forEach(cell => this._write(`<td>${this._esc(cell)}</td>`));
        this._write('</tr>');
        if (this.pretty) this._write('\n');
      });
      this._write('</tbody>');
      if (this.pretty) this._write('\n');
    }
    this._write('</table>');
    if (this.pretty) this._write('\n');
  }

  // ================================================================
  // 行内节点
  // ================================================================

  visit_RawText(node) { this._write(this._esc(node.text)); }
  visit_LineBreak(node) { this._write('<br>'); }

  visit_Bold(node) {
    this._write('<strong>');
    node.content.forEach(n => n.accept(this));
    this._write('</strong>');
  }

  visit_Italic(node) {
    this._write('<em>');
    node.content.forEach(n => n.accept(this));
    this._write('</em>');
  }

  visit_Strikethrough(node) {
    this._write('<del>');
    node.content.forEach(n => n.accept(this));
    this._write('</del>');
  }

  visit_InlineCode(node) {
    this._write(`<code>${this._esc(node.code)}</code>`);
  }

  visit_Link(node) {
    this._write(`<a href="${this._escAttr(node.url)}">${this._esc(node.text)}</a>`);
  }

  visit_Image(node) {
    const w = node.width ? ` width="${node.width}"` : '';
    this._write(`<img src="${this._escAttr(node.url)}" alt="${this._escAttr(node.alt)}"${w}>`);
  }

  visit_FunctionCall(node) {
    const func = this._functions[node.name];
    if (!func) {
      this._write(`<!-- mslang: unknown function @${node.name} -->`);
      return;
    }
    try {
      const result = func(...node.args, node.kwargs);
      if (typeof result === 'string') {
        this._write(result);
      } else if (Array.isArray(result)) {
        result.forEach(item => {
          if (typeof item === 'string') {
            this._write(this._esc(item));
          } else if (item.accept) {
            item.accept(this);
          }
        });
      } else {
        this._write(this._esc(String(result)));
      }
    } catch (e) {
      this._write(`<!-- mslang: function @${node.name} error: ${this._esc(String(e))} -->`);
    }
  }

  visit_Color(node) {
    this._write(`<span style="color:#${node.color}">${this._esc(node.text)}</span>`);
  }

  visit_Superscript(node) {
    this._write('<sup>');
    node.content.forEach(n => n.accept(this));
    this._write('</sup>');
  }

  visit_Subscript(node) {
    this._write('<sub>');
    node.content.forEach(n => n.accept(this));
    this._write('</sub>');
  }

  visit_RawHtml(node) {
    this._write(node.html);
  }

  visit_FootnoteRef(node) {
    this._write(`<sup><a href="#fn-${node.number}" id="fnref-${node.number}">` +
                `[${node.number}]</a></sup>`);
  }

  // ================================================================
  // 辅助方法
  // ================================================================

  _write(text) { this._output.push(text); }

  _esc(text) {
    if (this.escapeHtml) return escapeHTML(text);
    return text;
  }

  _escAttr(text) {
    if (this.escapeHtml) return escapeAttr(text);
    return text;
  }
}

export { HTMLRenderer, escapeHTML, escapeAttr };
