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
import { evaluate } from './expression.js';

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
   * @param {Object<string, Function>} [opts.functions] - 自定义函数（覆盖同名内置函数）
   */
  constructor(opts = {}) {
    this.pretty = opts.pretty !== false;
    this.escapeHtml = opts.escapeHtml !== false;
    this._data = {};
    this._variables = {};
    this._functions = { ...builtinFunctions(this), ...(opts.functions || {}) };
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
   * @param {object} [opts.data] - 注入数据（{ bibliography, terms, ... }）
   * @param {object} [opts.variables] - 注入变量（表达式裸词引用）
   * @param {string|boolean} [opts.headingNumbering] - 标题自动编号格式（如 '1.1'），
   *   开启后标题显示层级编号，@ref 显示编号；不配置则不编号
   * @param {string} [opts.refNumbering] - 从标题文本提取显式编号的模式
   *   （'1' 数字 / '一' 中文），提取到则 @ref 显示编号，否则显示标题全文
   * @returns {string}
   */
  render(source, opts = {}) {
    const {
      wrapperClass = 'mslang',
      wrapperId = '',
      data = {},
      variables = {},
      headingNumbering = '',
      refNumbering = '',
    } = opts;
    this._data = data || {};
    this._variables = variables || {};
    this._headingNumbering = headingNumbering === true ? '1.1' : (headingNumbering || '');
    this._refNumbering = refNumbering || '';
    this._output = [];

    let body;
    if (source instanceof Document) {
      this._applySets(source);
      this._collectRefs(source);
      source.accept(this);
      body = this._output.join('');
    } else {
      const lexer = new Lexer(source);
      const tokens = lexer.tokenize();
      const ast = new Parser().parse(tokens);
      this._applySets(ast);
      this._collectRefs(ast);
      ast.accept(this);
      body = this._output.join('');
    }

    const cls = wrapperClass ? ` class="${wrapperClass}"` : '';
    const id = wrapperId ? ` id="${wrapperId}"` : '';
    return `<div${cls}${id}>\n${body}\n</div>`;
  }

  // ================================================================
  // 文档内配置（@set）
  // ================================================================

  // @set 白名单：仅这些键可被文档内配置覆盖
  static SET_KEYS = ['headingNumbering', 'refNumbering', 'escapeHtml', 'pretty', 'data', 'variables'];

  /**
   * 预扫描文档顶层的 @set({...}) 调用并应用配置。
   * 必须在 _collectRefs 之前执行，使编号计算使用最终配置。
   * @set 全文档生效（建议放文档开头），仅识别块级内容中的顶层调用。
   */
  _applySets(doc) {
    const scan = (inlines) => {
      for (const n of inlines) {
        if (n instanceof FunctionCall && n.name === 'set') this._applySet(n);
      }
    };
    for (const block of doc.blocks) {
      if (block.content) scan(block.content);
      if (block.items) {
        for (const item of block.items) scan(item.content);
      }
    }
  }

  _applySet(node) {
    if (node.error || !node.args[0]) return;
    try {
      const ctx = { functions: this._functions, variables: this._variables };
      const config = evaluate(node.args[0], ctx);
      if (config && typeof config === 'object') this._mergeSet(config);
    } catch (e) {
      // 配置求值失败时忽略，渲染阶段由 set 函数输出错误注释
    }
  }

  /** 白名单合并：@set 覆盖同名选项 */
  _mergeSet(config) {
    for (const key of HTMLRenderer.SET_KEYS) {
      if (!(key in config)) continue;
      if (key === 'headingNumbering') {
        this._headingNumbering = config[key] === true ? '1.1' : (config[key] || '');
      } else if (key === 'refNumbering') {
        this._refNumbering = config[key] || '';
      } else if (key === 'data') {
        this._data = config[key] || {};
      } else if (key === 'variables') {
        this._variables = config[key] || {};
      } else {
        this[key] = config[key];
      }
    }
  }

  // ================================================================
  // 编号收集（渲染前对 AST 遍历一遍）
  // ================================================================

  /**
   * 收集引用编号，供渲染阶段回填：
   *   - cite("key") 按文档出现顺序编号 → _citeNumbers / _citeOrder
   *   - 图片/表格/标题的 label → _refs { label: { kind, number } }
   * 遍历顺序与渲染顺序一致（块 → 行内 → 表达式参数）。
   */
  _collectRefs(doc) {
    this._citeNumbers = {};
    this._citeOrder = [];
    this._refs = {};
    this._headingSeq = [];
    this._headingIdx = 0;
    const counters = { fig: 0, tbl: 0, sec: 0 };

    // 标题自动编号：按文档顺序对全部 Heading 计算层级编号（如 1 / 1.1 / 1.1.1）
    const sep = this._headingNumbering.match(/[^\d1]/)?.[0] || '.';
    const levelCounts = [0, 0, 0, 0, 0, 0];
    const nextSecNumber = (level) => {
      levelCounts[level - 1]++;
      for (let i = level; i < 6; i++) levelCounts[i] = 0;
      const parts = [];
      for (let i = 0; i < level; i++) parts.push(levelCounts[i]);
      return parts.join(sep);
    };

    const collectCite = (key) => {
      if (!(key in this._citeNumbers)) {
        this._citeNumbers[key] = this._citeOrder.length + 1;
        this._citeOrder.push(key);
      }
    };

    // 表达式树中的 cite 调用（嵌套于 if 等函数参数）
    const walkExpr = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'call') {
        if (node.name === 'cite' && node.args[0] && node.args[0].type === 'string') {
          collectCite(node.args[0].value);
        }
        node.args.forEach(walkExpr);
        Object.values(node.kwargs).forEach(walkExpr);
      } else if (node.type === 'unary') {
        walkExpr(node.operand);
      } else if (node.type === 'binary') {
        walkExpr(node.left);
        walkExpr(node.right);
      } else if (node.type === 'object') {
        Object.values(node.value).forEach(walkExpr);
      }
    };

    const walkInlines = (inlines) => {
      for (const n of inlines) {
        if (n instanceof Image && n.label) {
          counters.fig++;
          this._refs[n.label] = { kind: 'fig', number: counters.fig };
        }
        if (n instanceof FunctionCall) {
          // 顶层 @cite("key") 调用
          if (n.name === 'cite' && n.args[0] && n.args[0].type === 'string') {
            collectCite(n.args[0].value);
          }
          // 嵌套在参数表达式中的 cite
          n.args.forEach(walkExpr);
        }
        if (n.content) walkInlines(n.content);
      }
    };

    // 提取标题纯文本（递归穿过 Bold/Italic 等行内容器）
    const headingText = (nodes) => {
      let out = '';
      for (const n of nodes) {
        if (n instanceof RawText) out += n.text;
        else if (n.content) out += headingText(n.content);
      }
      return out;
    };

    for (const block of doc.blocks) {
      if (block instanceof Heading) {
        const autoNum = this._headingNumbering ? nextSecNumber(block.level) : '';
        this._headingSeq.push(autoNum);
        if (block.id) {
          counters.sec++;
          const text = headingText(block.content);
          // 统一优先级：显式提取编号 > 自动编号 > 标题全文
          let display;
          if (this._refNumbering) {
            display = extractHeadingNumber(text, this._refNumbering);
          }
          if (display === undefined && autoNum) display = autoNum;
          if (display === undefined) display = text || `第 ${counters.sec} 节`;
          this._refs[block.id] = { kind: 'sec', display };
        }
      }
      if (block instanceof Table && block.label) {
        counters.tbl++;
        this._refs[block.label] = { kind: 'tbl', number: counters.tbl };
      }
      if (block.content) walkInlines(block.content);
      if (block.items) {
        for (const item of block.items) {
          walkInlines(item.content);
          if (item.children) {
            for (const child of item.children) {
              if (child.content) walkInlines(child.content);
            }
          }
        }
      }
    }
  }

  /** 文献条目格式化：字符串原样转义；对象拼接 authors (year). title. journal. */
  _formatBibEntry(entry) {
    if (typeof entry === 'string') return this._esc(entry);
    const e = entry || {};
    const parts = [];
    if (e.authors) parts.push(this._esc(String(e.authors)));
    if (e.year !== undefined) parts.push(`(${this._esc(String(e.year))})`);
    const title = e.title ? this._esc(String(e.title)) : '';
    if (e.url) parts.push(`<a href="${this._escAttr(String(e.url))}">${title}</a>`);
    else if (title) parts.push(title);
    if (e.journal) parts.push(this._esc(String(e.journal)));
    return parts.join(' ');
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
    if (this._headingNumbering) {
      const num = this._headingSeq[this._headingIdx] || '';
      this._headingIdx++;
      if (num) this._write(`${num} `);
    }
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
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : '';
    this._write(`<table${id}>`);
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
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : '';
    // referrerpolicy="no-referrer": 绕过源站 Referer 防盗链
    this._write(`<img src="${this._escAttr(node.url)}" alt="${this._escAttr(node.alt)}"${w}${id} referrerpolicy="no-referrer">`);
  }

  visit_FunctionCall(node) {
    if (node.error) {
      this._write(`<!-- mslang: 参数解析错误 @${node.name}: ${this._esc(node.error)} -->`);
      return;
    }
    const func = this._functions[node.name];
    if (!func) {
      this._write(`<!-- mslang: unknown function @${node.name} -->`);
      return;
    }
    try {
      const ctx = { functions: this._functions, variables: this._variables };
      const args = node.args.map(a => evaluate(a, ctx));
      const kwargs = {};
      for (const [k, v] of Object.entries(node.kwargs)) kwargs[k] = evaluate(v, ctx);
      const result = func(...args, kwargs);
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

// ================================================================
// 内置函数
// ================================================================

// 显式编号提取正则：数字层级（1.1.2）与中文编号（第一章 / 一、 / （一））
const RE_NUM_ARABIC = /^(\d+(?:\.\d+)*)/;
const RE_NUM_CN = /^(第[一二三四五六七八九十百]+[章节篇]|[一二三四五六七八九十百]+[、．.]|（[一二三四五六七八九十百]+）|\([一二三四五六七八九十百]+\))/;

/**
 * 从标题文本开头提取显式编号。
 * @param {string} text
 * @param {string} mode - '1' 数字编号 / '一' 中文编号
 * @returns {string|undefined} 提取到的编号（剥离尾随顿号/点），未匹配返回 undefined
 */
function extractHeadingNumber(text, mode) {
  if (mode !== '1' && mode !== '一') return undefined;
  const re = mode === '1' ? RE_NUM_ARABIC : RE_NUM_CN;
  const m = text.match(re);
  if (!m) return undefined;
  let num = m[1];
  if (mode === '一') num = num.replace(/[、．.]+$/, '');
  return num;
}

/**
 * 论文写作常用内置函数：逻辑运算、文献引用、术语引用。
 * 通过 renderer.render(source, { data, variables }) 注入数据。
 */
function builtinFunctions(renderer) {
  const esc = (t) => renderer._esc(t);
  const escAttr = (t) => renderer._escAttr(t);

  return {
    if: (cond, then, els) => (cond ? then : (els === undefined ? '' : els)),
    not: (x) => !x,
    and: (...xs) => xs.every(Boolean),
    or: (...xs) => xs.some(Boolean),

    /** 文档内配置：@set({ headingNumbering: '1.1', ... })，无输出 */
    set: (config) => {
      if (config && typeof config === 'object') renderer._mergeSet(config);
      return '';
    },

    /** 文献键是否存在（供 if 条件使用） */
    has_cite: (key) => !!(renderer._data.bibliography && renderer._data.bibliography[key]),

    /** 术语是否存在（供 if 条件使用） */
    has_term: (name) => !!(renderer._data.terms && renderer._data.terms[name]),

    /** 文献引用：按文档出现顺序自动编号，输出上标链接 [n]，缺失时输出 [key?] 占位 */
    cite: (key) => {
      const entry = renderer._data.bibliography && renderer._data.bibliography[key];
      if (!entry) return `<sup>[${esc(String(key))}?]</sup>`;
      // 收集阶段未覆盖的键（如变量参数）在此动态编号
      if (!(key in renderer._citeNumbers)) {
        renderer._citeNumbers[key] = renderer._citeOrder.length + 1;
        renderer._citeOrder.push(key);
      }
      const num = renderer._citeNumbers[key];
      return `<sup><a href="#cite-${num}" id="ref-cite-${num}">[${esc(String(num))}]</a></sup>`;
    },

    /** 交叉引用：图/表显示"图 N/表 N"；章节显示 显式编号 → 自动编号 → 标题全文 */
    ref: (label) => {
      const r = renderer._refs[label];
      if (!r) return `<a href="#${escAttr(String(label))}">[${esc(String(label))}?]</a>`;
      let text;
      if (r.kind === 'fig') text = `图 ${r.number}`;
      else if (r.kind === 'tbl') text = `表 ${r.number}`;
      else text = r.display;
      return `<a href="#${escAttr(String(label))}">${esc(text)}</a>`;
    },

    /** 文献表：列出全部被引用文献（按编号顺序），生成 <ol> 锚点与 cite 对应 */
    bibliography: () => {
      const items = renderer._citeOrder
        .map((key, i) => {
          const entry = renderer._data.bibliography && renderer._data.bibliography[key];
          if (entry === undefined) return null;
          return `<li id="cite-${i + 1}">${renderer._formatBibEntry(entry)}</li>`;
        })
        .filter(Boolean);
      if (!items.length) return '';
      return `<ol class="bibliography">\n${items.join('\n')}\n</ol>`;
    },

    /** 术语引用：输出 <span class="term">，数据可带 label / url */
    term: (name, kwargs) => {
      const entry = renderer._data.terms && renderer._data.terms[name];
      const label = (entry && entry.label) ? entry.label : name;
      const inner = `<span class="term">${esc(String(label))}</span>`;
      const url = (entry && entry.url) ? entry.url : '';
      return url ? `<a href="${escAttr(String(url))}">${inner}</a>` : inner;
    },
  };
}

export { HTMLRenderer, escapeHTML, escapeAttr };
