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
  Superscript, Subscript, RawHtml, Table, FootnoteRef, AlignBlock, Equation,
} from './nodes.js';

import { Lexer } from './lexer.js';
import { Parser, mergeDocuments } from './parser.js';
import { evaluate } from './expression.js';
import { builtinFunctions, extractHeadingNumber } from './builtin.js';
import { escapeHTML, escapeAttr } from './escape.js';
import katex from 'katex';

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
    this._applyOpts(opts);
    const doc = this._parseDoc(source);
    this._applySets(doc);
    this._collectRefs(doc);
    doc.accept(this);
    const body = this._output.join('');
    return this._wrap(body, opts);
  }

  /**
   * 异步渲染：支持返回 Promise 的自定义函数（如网络请求）。
   * 与 render() 语义一致，仅异步函数结果会真正渲染进 HTML；
   * 多个异步函数并行等待，reject 时输出错误注释而非抛错。
   * @param {string|Document} source
   * @param {object} [opts] - 与 render() 相同
   * @returns {Promise<string>}
   */
  async renderAsync(source, opts = {}) {
    this._applyOpts(opts);
    this._asyncSlots = [];
    this._asyncId = 0;
    const doc = this._parseDoc(source);
    this._applySets(doc);
    this._collectRefs(doc);
    doc.accept(this);
    await Promise.all(this._asyncSlots.map(s => s.promise));
    let body = this._output.join('');
    for (const slot of this._asyncSlots) {
      body = body.split(slot.token).join(slot.html);
    }
    return this._wrap(body, opts);
  }

  /**
   * 渲染多个文档的合并结果：跨文档连续编号、交叉引用、全局 @set。
   * @param {(string|Document)[]} sources - mslang 文本或 Document，顺序即编号顺序
   * @param {object} [opts] - 与 render() 相同
   * @returns {string}
   */
  renderAll(sources, opts = {}) {
    const docs = sources.map(s => this._parseDoc(s));
    return this.render(mergeDocuments(...docs), opts);
  }

  /** 异步版 renderAll，语义与 renderAsync 相同 */
  async renderAllAsync(sources, opts = {}) {
    const docs = sources.map(s => this._parseDoc(s));
    return this.renderAsync(mergeDocuments(...docs), opts);
  }

  /** 应用渲染选项（render / renderAsync 共用） */
  _applyOpts(opts) {
    const {
      data = {},
      variables = {},
      headingNumbering = '',
      refNumbering = '',
      captionPrefix = {},
      citeKeyAttr = HTMLRenderer.DEFAULT_KEY_ATTRS.citeKeyAttr,
      termKeyAttr = HTMLRenderer.DEFAULT_KEY_ATTRS.termKeyAttr,
      refKeyAttr = HTMLRenderer.DEFAULT_KEY_ATTRS.refKeyAttr,
      mathRenderer = null,
    } = opts;
    this._data = data || {};
    this._variables = variables || {};
    this._headingNumbering = headingNumbering === true ? '1.1' : (headingNumbering || '');
    this._refNumbering = refNumbering || '';
    this._captionPrefix = { ...HTMLRenderer.DEFAULT_CAPTION_PREFIX, ...captionPrefix };
    this._citeKeyAttr = citeKeyAttr || '';
    this._termKeyAttr = termKeyAttr || '';
    this._refKeyAttr = refKeyAttr || '';
    // mathRenderer 默认使用内置 KaTeX 渲染（可传选项覆盖）
    this._mathRenderer = mathRenderer || ((src, inline) =>
      katex.renderToString(src, { displayMode: !inline, throwOnError: false }));
    this._evalCtx = { functions: this._functions, variables: this._variables };
    this._output = [];
    this._asyncSlots = null;
  }

  /** 解析输入为 Document（render / renderAsync 共用） */
  _parseDoc(source) {
    return source instanceof Document
      ? source
      : new Parser().parse(new Lexer(source).tokenize());
  }

  /** 包一层 wrapper div */
  _wrap(body, opts) {
    const wrapperClass = opts.wrapperClass || 'mslang';
    const wrapperId = opts.wrapperId || '';
    const cls = wrapperClass ? ` class="${wrapperClass}"` : '';
    const id = wrapperId ? ` id="${wrapperId}"` : '';
    return `<div${cls}${id}>\n${body}\n</div>`;
  }

  // ================================================================
  // 文档内配置（@set）
  // ================================================================

  // @set 白名单：仅这些键可被文档内配置覆盖
  static SET_KEYS = ['headingNumbering', 'refNumbering', 'escapeHtml', 'pretty', 'data', 'variables', 'terms', 'bibliography', 'captionPrefix', 'citeKeyAttr', 'termKeyAttr', 'refKeyAttr'];

  // 引用/术语 data 属性名（工作台交互定位用；空串关闭）
  static DEFAULT_KEY_ATTRS = { citeKeyAttr: 'data-cite-key', termKeyAttr: 'data-term-key', refKeyAttr: 'data-ref-label' };

  // caption 前缀（默认中文，可用 @set 覆盖）
  static DEFAULT_CAPTION_PREFIX = { fig: '图', tbl: '表', eq: '式' };

  /**
   * 预扫描文档顶层的 @set({...}) 调用并应用配置。
   * 必须在 _collectRefs 之前执行，使编号计算使用最终配置。
   * @set 全文档生效（建议放文档开头），仅识别块级内容中的顶层调用。
   */
  /**
   * 遍历文档全部行内节点（块 → 列表项 → 子项，递归穿过行内容器）。
   * _applySets / _collectRefs 共用，遍历顺序与渲染顺序一致。
   */
  _eachInline(doc, fn) {
    const walk = (inlines) => {
      for (const n of inlines) {
        fn(n);
        if (n.content) walk(n.content);
        if (n.caption) walk(n.caption);
      }
    };
    for (const block of doc.blocks) {
      if (block.content) walk(block.content);
      if (block.items) {
        for (const item of block.items) {
          walk(item.content);
          if (item.children) {
            for (const child of item.children) {
              if (child.content) walk(child.content);
            }
          }
        }
      }
    }
  }

  _applySets(doc) {
    this._eachInline(doc, (n) => {
      if (n instanceof FunctionCall && n.name === 'set') this._applySet(n);
      else if (n instanceof FunctionCall && n.name === 'let') this._applyLet(n);
    });
  }

  _applySet(node) {
    if (node.error || !node.args[0]) return;
    try {
      const config = evaluate(node.args[0], this._evalCtx);
      if (config && typeof config === 'object') this._mergeSet(config);
    } catch (e) {
      // 配置求值失败时忽略，渲染阶段由 set 函数输出错误注释
    }
  }

  /**
   * 预扫描注册 @let 声明的变量（与 _applySet 同步执行），
   * 使变量全文档可见：@set 参数、@ref 编号计算、渲染阶段均可引用。
   * 求值失败时忽略，渲染阶段由 let 函数输出错误注释。
   */
  _applyLet(node) {
    if (node.error || node.args.length < 2) return;
    try {
      const name = evaluate(node.args[0], this._evalCtx);
      const value = evaluate(node.args[1], this._evalCtx);
      if (typeof name === 'string') this._variables[name] = value;
    } catch (e) {
      // 变量求值失败时忽略（如依赖后文变量），渲染阶段按文档顺序再次尝试
    }
  }

  /** 白名单合并：@set 覆盖同名选项；terms/bibliography 增量合并（可多次设置） */
  _mergeSet(config) {
    for (const key of HTMLRenderer.SET_KEYS) {
      if (!(key in config)) continue;
      if (key === 'headingNumbering') {
        this._headingNumbering = config[key] === true ? '1.1' : (config[key] || '');
      } else if (key === 'refNumbering') {
        this._refNumbering = config[key] || '';
      } else if (key === 'data') {
        this._data = this._mergeData(this._data, config[key]);
      } else if (key === 'terms' || key === 'bibliography') {
        this._data = this._mergeData(this._data, { [key]: config[key] });
      } else if (key === 'variables') {
        // 就地合并（不替换对象）：保持 _evalCtx.variables 引用有效
        Object.assign(this._variables, config[key] || {});
      } else if (key === 'captionPrefix') {
        this._captionPrefix = { ...this._captionPrefix, ...config[key] };
      } else if (key === 'citeKeyAttr' || key === 'termKeyAttr' || key === 'refKeyAttr') {
        this[`_${key}`] = config[key] || '';
      } else {
        this[key] = config[key];
      }
    }
  }

  /** 数据合并：一层深合并（terms/bibliography 按 key 合并），其余键整体替换 */
  _mergeData(existing, incoming) {
    if (!incoming || typeof incoming !== 'object') return existing;
    const out = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      const isPlainObj = v && typeof v === 'object' && !Array.isArray(v);
      if (isPlainObj && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = { ...out[k], ...v };
      } else {
        out[k] = v;
      }
    }
    return out;
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
    const counters = { fig: 0, tbl: 0, sec: 0, eq: 0 };

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

    // 表达式树中的 cite 调用（嵌套于 if 等函数参数）
    const walkExpr = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'call') {
        if (node.name === 'cite' && node.args[0] && node.args[0].type === 'string') {
          this._registerCite(node.args[0].value);
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
      } else if (node.type === 'array') {
        node.items.forEach(walkExpr);
      }
    };

    const walkInlines = (n) => {
      if (n instanceof Image && n.label) {
        counters.fig++;
        this._refs[n.label] = { kind: 'fig', number: counters.fig };
      }
      if (n instanceof FunctionCall) {
        // 顶层 @cite("key") 调用
        if (n.name === 'cite' && n.args[0] && n.args[0].type === 'string') {
          this._registerCite(n.args[0].value);
        }
        // 嵌套在参数表达式中的 cite
        n.args.forEach(walkExpr);
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

    this._eachInline(doc, walkInlines);

    // 标题/表格的引用编号（计数器相互独立，顺序与渲染一致）
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
      if (block instanceof Equation && block.label) {
        counters.eq++;
        this._refs[block.label] = { kind: 'eq', number: counters.eq };
      }
    }
  }

  /**
   * 文献键编号：首次出现分配顺序号（_collectRefs 预收集与运行时 cite 共用）。
   * @param {string} key
   */
  _registerCite(key) {
    if (!(key in this._citeNumbers)) {
      this._citeNumbers[key] = this._citeOrder.length + 1;
      this._citeOrder.push(key);
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
    // 单图片段落且带 caption：渲染为 <figure>（id 上移到 figure）
    if (node.content.length === 1 &&
        node.content[0] instanceof Image && node.content[0].caption.length) {
      this._visitFigure(node.content[0]);
      return;
    }
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

  /** 带 caption 的图片渲染为 <figure>（图下方 figcaption） */
  _visitFigure(image) {
    const ref = this._refs[image.label];
    const num = ref ? ref.number : '';
    const id = image.label ? ` id="${this._escAttr(image.label)}"` : '';
    const width = image.width ? ` width="${image.width}"` : '';
    this._write(`<figure${id}>`);
    if (this.pretty) this._write('\n');
    this._write(`<img src="${this._escAttr(image.url)}" alt="${this._escAttr(image.alt)}"${width} referrerpolicy="no-referrer">`);
    if (this.pretty) this._write('\n');
    this._write(`<figcaption>${this._esc(this._captionPrefix.fig)} ${num}：`);
    image.caption.forEach(n => n.accept(this));
    this._write('</figcaption>');
    if (this.pretty) this._write('\n');
    this._write('</figure>');
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
    // caption 必须位于 table 首个子元素（表头上方）
    if (node.caption.length) {
      const ref = this._refs[node.label];
      const num = ref ? ref.number : '';
      this._write(`<caption>${this._esc(this._captionPrefix.tbl)} ${num}：`);
      node.caption.forEach(n => n.accept(this));
      this._write('</caption>');
      if (this.pretty) this._write('\n');
    }
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

  /**
   * 公式：行内 <span class="math-inline">，块级 <div class="math">。
   * mathRenderer 选项存在时调用其渲染（返回 HTML 不转义），否则源码转义透传。
   * 块级公式带 caption 时包 <figure>（与图片一致）。
   */
  visit_Equation(node) {
    const html = this._mathRenderer
      ? this._mathRenderer(node.source, node.inline)
      : this._esc(node.source);
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : '';
    if (node.inline) {
      this._write(`<span class="math-inline"${id}>${html}</span>`);
      return;
    }
    if (node.caption.length) {
      const ref = this._refs[node.label];
      const num = ref ? ref.number : '';
      this._write(`<figure${id}>`);
      if (this.pretty) this._write('\n');
      this._write(`<div class="math">${html}</div>`);
      if (this.pretty) this._write('\n');
      this._write(`<figcaption>${this._esc(this._captionPrefix.eq)} ${num}：`);
      node.caption.forEach(n => n.accept(this));
      this._write('</figcaption>');
      if (this.pretty) this._write('\n');
      this._write('</figure>');
      if (this.pretty) this._write('\n');
      return;
    }
    this._write(`<div class="math"${id}>${html}</div>`);
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
    let result;
    try {
      const args = node.args.map(a => evaluate(a, this._evalCtx));
      const kwargs = {};
      for (const [k, v] of Object.entries(node.kwargs)) kwargs[k] = evaluate(v, this._evalCtx);
      result = func(...args, kwargs);
    } catch (e) {
      this._write(this._functionError(node.name, e));
      return;
    }

    if (result instanceof Promise) {
      if (this._asyncSlots) {
        // 异步模式：占位符 + 结果回填
        const id = ++this._asyncId;
        const slot = { token: `\u0000ASYNC${id}\u0000`, html: '' };
        slot.promise = Promise.resolve(result).then(
          (value) => { slot.html = this._renderValue(value); },
          (err) => { slot.html = this._functionError(node.name, err, true); },
        );
        this._asyncSlots.push(slot);
        this._output.push(slot.token);
      } else {
        this._write(`<!-- mslang: async function @${node.name} 需使用 renderAsync() -->`);
      }
      return;
    }

    this._write(this._renderValue(result));
  }

  /** 函数调用错误注释（同步/异步共用） */
  _functionError(name, err, isAsync) {
    const prefix = isAsync ? 'async function' : 'function';
    const msg = isAsync ? String((err && err.message) || err) : String(err);
    return `<!-- mslang: ${prefix} @${name} error: ${this._esc(msg)} -->`;
  }

  /**
   * 将函数返回值渲染为 HTML 字符串：
   * 字符串原样输出（视为 HTML）；数组逐项处理（字符串转义、AST 节点递归渲染）；
   * 其他值转义后输出。
   */
  _renderValue(result) {
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
      return result.map(item => {
        if (typeof item === 'string') return this._esc(item);
        if (item && item.accept) return this._renderSubtree(item);
        return '';
      }).join('');
    }
    return this._esc(String(result));
  }

  /** 在独立输出缓冲中渲染子树，返回 HTML 字符串 */
  _renderSubtree(node) {
    const saved = this._output;
    this._output = [];
    node.accept(this);
    const html = this._output.join('');
    this._output = saved;
    return html;
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
