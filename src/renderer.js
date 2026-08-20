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
  Superscript, Subscript, RawHtml, Table, FootnoteRef, AlignBlock, Equation, Theorem, PartBlock,
} from './nodes.js';

import { parseInlineFragment } from './parse-utils.js';
import { evaluate } from './expression.js';
import { htmlBuiltins } from './builtin.js';
import { escapeHTML, escapeAttr, safeLinkUrl, safeImageUrl } from './escape.js';
import { RuntimeContext, SET_KEYS, DEFAULT_CAPTION_PREFIX, DEFAULT_KEY_ATTRS, mergeCaptionPrefix } from './runtime.js';
import { prepare } from './prepare.js';
import { checkIntegrity, DIAG_ISSUE_TYPE } from './semantic.js';
import { CitationEngine } from './citation.js';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import perl from 'highlight.js/lib/languages/perl';
import yaml from 'highlight.js/lib/languages/yaml';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import diff from 'highlight.js/lib/languages/diff';

// 代码高亮语言子集（常用论文/脚本语言，控制体积）
const HLJS_LANGUAGES = {
  javascript, typescript, python, java, c, cpp, go, rust, bash, json, sql, xml, css, markdown,
  kotlin, swift, ruby, php, perl, yaml, dockerfile, diff,
};
for (const [name, lang] of Object.entries(HLJS_LANGUAGES)) hljs.registerLanguage(name, lang);

// 宏展开递归深度上限（@use 模板内嵌 @use 的自引用防护）
const MAX_MACRO_DEPTH = 32;

// KaTeX / hljs 渲染结果缓存（跨 render 实例共享，供工作台增量重渲复用）。
// 二者输出是确定性纯函数，memoization 安全；上限防内存膨胀（超限淘汰最早插入）。
const MATH_CACHE = new Map();
const CODE_CACHE = new Map();
const CACHE_LIMIT = 500;
function cacheGet(map, key) {
  return map.get(key);
}
function cacheSet(map, key, value) {
  if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
}

// 块哈希：djb2（块源 + 编号前缀快照 → 定位变化块，供块级编辑 DOM patch）
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// KaTeX CSS 内容：dist 由 esbuild define 注入；Node 直接运行 src/ 时读取依赖包内文件。
// 文档含公式且未自定义 mathRenderer 时内联 <style>（katex 输出依赖此 CSS 排版）。
let katexCss = '';
try {
  if (typeof KATEX_CSS !== 'undefined') {
    katexCss = KATEX_CSS;
  } else if (typeof process !== 'undefined' && process.getBuiltinModule) {
    const { readFileSync } = process.getBuiltinModule('fs');
    katexCss = readFileSync(`${process.cwd()}/node_modules/katex/dist/katex.min.css`, 'utf8');
  }
} catch { katexCss = ''; }

// highlight.js github 主题（dist 由 esbuild define 注入；Node 直接运行 src/ 时读取依赖包内文件）
let highlightCss = '';
try {
  if (typeof HIGHLIGHT_CSS !== 'undefined') {
    highlightCss = HIGHLIGHT_CSS;
  } else if (typeof process !== 'undefined' && process.getBuiltinModule) {
    const { readFileSync } = process.getBuiltinModule('fs');
    highlightCss = readFileSync(`${process.cwd()}/node_modules/highlight.js/styles/github.css`, 'utf8');
  }
} catch { highlightCss = ''; }

// KaTeX 字体默认 CDN（与内联 CSS 的 @font-face 对应；可用 mathFontsPath 选项本地托管）
const KATEX_FONTS_CDN = `https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/fonts/`;

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
    // 预注册 host 函数（独立 new HTMLRenderer + addFunction 场景；prepare 注入时合并保留）
    this._hostFunctions = { ...(opts.functions || {}) };
    // runtime 通常由 prepare() 注入（PreparedDocument.runtime）；此处兜底独立创建
    this.runtime = opts.runtime instanceof RuntimeContext
      ? opts.runtime
      : new RuntimeContext({ functions: opts.functions, escapeHtml: opts.escapeHtml, pretty: opts.pretty });
    // HTML 内置函数注入（host/runtime builtin 覆盖 — host 可覆盖 cite 等既有行为）
    this.runtime.functions = { ...htmlBuiltins(this), ...this.runtime.functions };
    // 引用格式化适配器（0.3）：options.citation = { style?, locale?, engine? }；
    // style（CSL 样式如 'apa'）提供时自动启用 CSL 后端（宿主已安装 @citation-js，否则回退 lightweight）
    this.citation = new CitationEngine({ ...(opts.citation || {}) });
    this._output = [];
  }

  /**
   * 绑定 PreparedDocument（prepare() 唯一管线产物）：共享 runtime/semantic，
   * 同步渲染期语义视图（builtin 读 _refs/_citeNumbers 等），设置渲染专用字段。
   * 不再 resetHost/解析/扫描语义——全部来自 prepared。
   */
  _bindPrepared(prepared, opts) {
    this.runtime = prepared.runtime;
    // 合并 renderer 预注册 host 函数（独立 new HTMLRenderer + addFunction 场景）+ HTML builtin
    this.runtime.functions = {
      ...htmlBuiltins(this),
      ...(prepared.runtime.functions || {}),
      ...this._hostFunctions,
    };
    this.semantic = prepared.semantic;
    // 同引用同步语义状态（渲染期动态注册与 builtin 读取共享同一份）
    this._refs = this.semantic.refs;
    this._citeNumbers = this.semantic.citeNumbers;
    this._citeOrder = this.semantic.citeOrder;
    this._citeYearSuffix = this.semantic.citeYearSuffix;
    this._termOrder = this.semantic.termOrder;
    this._headingSeq = this.semantic.headingSeq;
    this._headingIdx = 0;
    // 渲染专用字段（每次渲染重置）
    const {
      mathRenderer = null,
      mathFontsPath = '',
      codeRenderer = null,
      blockMarkers = false,
    } = opts;
    this._mathRenderer = mathRenderer || ((src, inline) =>
      katex.renderToString(src, { displayMode: !inline, throwOnError: false }));
    this._mathFontsPath = mathFontsPath || '';
    this._codeRenderer = codeRenderer || null;
    this._blockMarkers = blockMarkers === true;
    this._blockHashes = {};
    this._output = [];
    this._asyncSlots = this._asyncSlots !== undefined ? this._asyncSlots : null;
    this._hasMath = false;
    this._mathRendererCustom = !!mathRenderer;
    this._hasHighlight = false;
    this._useDepth = 0;
  }

  // 配置视图：渲染/内置函数统一经 getter 读 runtime（单一配置源，@set 即时生效）
  get escapeHtml() { return this.runtime.escapeHtml; }
  get pretty() { return this.runtime.pretty; }
  get _allowPlugins() { return this.runtime.allowPlugins; }
  get _headingNumbering() { return this.runtime.headingNumbering; }
  get _refNumbering() { return this.runtime.refNumbering; }
  get _captionPrefix() { return this.runtime.captionPrefix; }
  get _citeKeyAttr() { return this.runtime.citeKeyAttr; }
  get _termKeyAttr() { return this.runtime.termKeyAttr; }
  get _refKeyAttr() { return this.runtime.refKeyAttr; }
  get _citeStyle() { return this.runtime.citeStyle; }
  get _bibStyle() { return this.runtime.bibStyle; }
  get _data() { return this.runtime.data; }
  get _variables() { return this.runtime.variables; }
  get _macros() { return this.runtime.macros; }
  get _functions() { return this.runtime.functions; }
  get _pluginCache() { return this.runtime.pluginCache; }
  get _evalCtx() { return this.runtime.evalCtx; }

  /**
   * 注册自定义函数
   * @param {string} name
   * @param {Function} func
   */
  addFunction(name, func) {
    this.runtime.functions[name] = func;
    this._hostFunctions[name] = func;
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
    if (Array.isArray(source)) return this.renderAll(source, opts);
    if (opts.async) return this.renderAsync(source, opts);
    if (opts.blocks) return this.renderBlocks(source, opts);
    const prepared = prepare(source, opts);
    return prepared instanceof Promise
      ? prepared.then((p) => this._renderPrepared(p, opts))
      : this._renderPrepared(prepared, opts);
  }

  /** 核心渲染：基于 PreparedDocument（prepare 唯一管线），只做 AST→HTML */
  _renderPrepared(prepared, opts) {
    this._bindPrepared(prepared, opts);
    const doc = prepared.document;
    doc.accept(this);
    const body = this._output.join('');
    const html = this._inlineStyles() + this._wrap(body, opts);
    if (opts.check) return { html, issues: toLegacyIssues(prepared, this) };
    return html;
  }

  /**
   * 单块渲染（块级编辑闭环）：prepare 全量收集语义后只渲染第 index 块。
   * 返回该块的 HTML（无 wrapper/哨兵），宿主替换对应 DOM 即可。
   * @param {string|Document} source
   * @param {number} index - 块索引（与 Parser.parseText(source).blocks 对齐）
   * @param {object} [opts] - 与 render() 相同（blocks/check 选项忽略）
   * @returns {string}
   */
  renderBlock(source, index, opts = {}) {
    const prepared = prepare(source, opts);
    if (prepared instanceof Promise) {
      throw new Error('renderBlock 不支持异步 include loader（请用同步 loader）');
    }
    this._bindPrepared(prepared, opts);
    const doc = prepared.document;
    const block = doc.blocks[index];
    if (!block) return '';
    // visit_Heading 用 _headingIdx 消费 _headingSeq：定位到该块对应的标题偏移
    let headingIdx = 0;
    const countHeadings = (blocks) => {
      for (const b of blocks) {
        if (b instanceof PartBlock) countHeadings(b.blocks);
        else if (b instanceof Heading) headingIdx++;
      }
    };
    countHeadings(doc.blocks.slice(0, index));
    this._headingIdx = headingIdx;
    this._output = [];
    block.accept(this);
    return this._output.join('');
  }

  /**
   * 块级渲染（块级编辑器用）：与 render() 同管线，额外产出：
   * - html 含 <!--mslang:N--> 块哨兵（footnotes 区为 <!--mslang:footnotes-->）
   * - blockHashes[N] = 块源 + 编号前缀快照的哈希，定位变化块（DOM 增量替换）
   * 编辑块 i 后重调本方法，对比新旧 blockHashes，替换哈希变化的块区间即可。
   * @returns {{ html: string, blockHashes: Object }}
   */
  renderBlocks(source, opts = {}) {
    const prepared = prepare(source, { ...opts, blockMarkers: true });
    const run = (p) => {
      this._bindPrepared(p, { ...opts, blockMarkers: true });
      const doc = p.document;
      doc.accept(this);
      const body = this._output.join('');
      const out = {
        html: this._inlineStyles() + this._wrap(body, opts),
        blockHashes: this._blockHashes,
      };
      if (opts.check) out.issues = toLegacyIssues(p, this);
      return out;
    };
    return prepared instanceof Promise ? prepared.then(run) : run(prepared);
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
    const prepared = await prepare(source, opts);
    this._bindPrepared(prepared, opts);
    this._asyncSlots = [];
    this._asyncId = 0;
    prepared.document.accept(this);
    await Promise.all(this._asyncSlots.map(s => s.promise));
    let body = this._output.join('');
    for (const slot of this._asyncSlots) {
      body = body.split(slot.token).join(slot.html);
    }
    const html = this._inlineStyles() + this._wrap(body, opts);
    if (opts.check) return { html, issues: toLegacyIssues(prepared, this) };
    return html;
  }

  /**
   * 渲染多个文档的合并结果：跨文档连续编号、交叉引用、全局 @set。
   * @param {(string|Document)[]} sources - mslang 文本或 Document，顺序即编号顺序
   * @param {object} [opts] - 与 render() 相同
   * @returns {string}
   */
  renderAll(sources, opts = {}) {
    // 多文档合并：归入 prepare()（前端统一处理），Renderer 只消费 PreparedDocument
    const prepared = prepare(sources, opts);
    const run = (p) => {
      // blocks 选项转发：多文档合并的块级渲染（跨文档连续编号 + 哨兵）
      if (opts.blocks) return this.renderBlocks(p.document, opts);
      return this._renderPrepared(p, opts);
    };
    return prepared instanceof Promise ? prepared.then(run) : run(prepared);
  }

  /** 异步版 renderAll，语义与 renderAsync 相同 */
  renderAllAsync(sources, opts = {}) {
    const prepared = prepare(sources, opts);
    const run = (p) => (opts.blocks
      ? this.renderBlocks(p.document, opts)
      : this.renderAsync(p.document, opts));
    return prepared instanceof Promise ? prepared.then(run) : run(prepared);
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

  // @set 白名单 / 默认常量（定义于 runtime.js，此处别名兼容内部/外部引用）
  static SET_KEYS = SET_KEYS;
  static DEFAULT_KEY_ATTRS = DEFAULT_KEY_ATTRS;
  static DEFAULT_CAPTION_PREFIX = DEFAULT_CAPTION_PREFIX;
  static _mergeCaptionPrefix = mergeCaptionPrefix;

  /** 参考文献键编号：首次出现分配顺序号（预收集与运行时 cite 共用）。 */
  _registerCite(key) {
    if (!(key in this._citeNumbers)) {
      this._citeNumbers[key] = this._citeOrder.length + 1;
      this._citeOrder.push(key);
    }
  }

  /** 术语键收集：首次出现加入 _termOrder（_collectRefs 预收集与运行时 term 共用） */
  _registerTerm(name) {
    if (!this._termOrder.includes(name)) this._termOrder.push(name);
  }

  /** 文献条目格式化：委托 CitationEngine（0.3 边界：引用格式化收口到 citation.js）。
   *  lightweight 分支兼容旧模型与 CSL-JSON；提供 citation.style 且 CSL 可用时走 CSL 后端。 */
  _formatBibEntry(entry) {
    return this.citation.formatBibliography(entry, { bibStyle: this._bibStyle, escapeHtml: this.escapeHtml });
  }

  // ================================================================
  // Visitor 实现
  // ================================================================

  genericVisit(node) {
    this._write(`<!-- unhandled: ${node.constructor.name} -->`);
  }

  visit_Document(doc) {
    doc.blocks.forEach((block, i) => {
      if (this._blockMarkers) {
        this._write(`<!--mslang:${i}-->\n`);
        // 哈希 = 块源 + 编号前缀快照 + 渲染依赖（变量/宏/data 条目变化 → 引用块哈希变）
        this._blockHashes[i] = djb2(
          `${block.raw || ''}|${JSON.stringify(block._prefixCounts || {})}|${JSON.stringify(block._deps || {})}`,
        );
      }
      block.accept(this);
      if (this.pretty && i < doc.blocks.length - 1) this._write('\n');
    });

    // 脚注区域
    if (Object.keys(doc.footnotes).length > 0) {
      if (this.pretty) this._write('\n');
      if (this._blockMarkers) {
        this._write('<!--mslang:footnotes-->\n');
        this._blockHashes.footnotes = djb2(JSON.stringify(doc.footnotes));
      }
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

  /**
   * figure 包裹：id 属性 + 主体 HTML + 可选 figcaption（prefix N：caption 行内节点）。
   * 图片/公式/mermaid 共用。
   */
  _writeFigure(idAttr, bodyHtml, caption, prefix, num) {
    this._write(`<figure${idAttr}>`);
    if (this.pretty) this._write('\n');
    this._write(bodyHtml);
    if (this.pretty) this._write('\n');
    if (caption && caption.length) {
      this._write(`<figcaption>${this._esc(prefix)} ${num}：`);
      caption.forEach(n => n.accept(this));
      this._write('</figcaption>');
      if (this.pretty) this._write('\n');
    }
    this._write('</figure>');
    if (this.pretty) this._write('\n');
  }

  /** 带 caption 的图片渲染为 <figure>（图下方 figcaption） */
  _visitFigure(image) {
    const ref = this._refs[image.label];
    const num = ref ? ref.number : '';
    const id = image.label ? ` id="${this._escAttr(image.label)}"` : '';
    const width = image.width ? ` width="${image.width}"` : '';
    const img = `<img src="${this._escAttr(safeImageUrl(image.url))}" alt="${this._escAttr(image.alt)}"${width} referrerpolicy="no-referrer">`;
    this._writeFigure(id, img, image.caption, this._captionPrefix.fig, num);
  }

  visit_CodeBlock(node) {
    // mermaid 流程图：div.mermaid（浏览器端 mermaid.run() 渲染成 SVG）；
    // 带 label 时包 figure + figcaption（参与 fig 编号）
    if (node.language === 'mermaid') {
      const body = this._codeRenderer
        ? this._codeRenderer(node.code, node.language)
        : this._esc(node.code);
      if (!node.label) {
        this._write(`<div class="mermaid">${body}</div>`);
        if (this.pretty) this._write('\n');
        return;
      }
      const ref = this._refs[node.label];
      const num = ref ? ref.number : '';
      this._writeFigure(` id="${this._escAttr(node.label)}"`, `<div class="mermaid">${body}</div>`, node.caption, this._captionPrefix.fig, num);
      return;
    }
    const langAttr = node.language ? ` data-language="${this._escAttr(node.language)}"` : '';
    // 代码高亮：语言在 hljs 子集内时输出 hljs 渲染（已转义，class 带语言标记）；
    // 结果按 (language, code) 缓存，跨实例复用
    let codeHtml = this._esc(node.code);
    let hljsClass = '';
    if (node.language && hljs.getLanguage(node.language)) {
      this._hasHighlight = true;
      const key = `${node.language}|${node.code}`;
      codeHtml = cacheGet(CODE_CACHE, key);
      if (codeHtml === undefined) {
        codeHtml = cacheSet(CODE_CACHE, key, hljs.highlight(node.code, { language: node.language }).value);
      }
      hljsClass = ` class="hljs language-${this._escAttr(node.language)}"`;
    }
    this._write(`<pre${langAttr}><code${hljsClass}>${codeHtml}</code></pre>`);
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
      node.headers.forEach(h => {
        this._write('<th>');
        h.forEach(n => n.accept(this));
        this._write('</th>');
      });
      this._write('</tr></thead>');
      if (this.pretty) this._write('\n');
    }
    if (node.rows.length) {
      this._write('<tbody>');
      if (this.pretty) this._write('\n');
      node.rows.forEach(row => {
        this._write('<tr>');
        row.forEach(cell => {
          this._write('<td>');
          cell.forEach(n => n.accept(this));
          this._write('</td>');
        });
        this._write('</tr>');
        if (this.pretty) this._write('\n');
      });
      this._write('</tbody>');
      if (this.pretty) this._write('\n');
    }
    this._write('</table>');
    if (this.pretty) this._write('\n');
  }

  /** 定理环境：<div class="theorem {type}" id="label"> + 标题行（定理 N 标题）+ 内容 */
  visit_Theorem(node) {
    const ref = this._refs[node.label];
    const num = ref ? ref.number : '';
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : '';
    const prefix = (this._captionPrefix.thm && this._captionPrefix.thm[node.type]) || '定理';
    this._write(`<div class="theorem ${node.type}"${id}>`);
    if (this.pretty) this._write('\n');
    if (node.label || node.title.length) {
      this._write(`<div class="theorem-label">${this._esc(prefix)} ${num}`);
      if (node.title.length) {
        this._write(' ');
        node.title.forEach(n => n.accept(this));
      }
      this._write('</div>');
      if (this.pretty) this._write('\n');
    }
    node.content.forEach(n => n.accept(this));
    if (this.pretty) this._write('\n');
    this._write('</div>');
    if (this.pretty) this._write('\n');
  }

  /**
   * @part 区间：<section class="part" id> + 标题（h2，无编号）+ 内部块顺序渲染。
   * 单独渲染 = 带锚点章节；@include 展开时标记行被文本层替换，不经过本方法。
   */
  visit_PartBlock(node) {
    const id = node.id ? ` id="${this._escAttr(node.id)}"` : '';
    this._write(`<section class="part"${id}>`);
    if (this.pretty) this._write('\n');
    if (node.title.length) {
      this._write('<h2>');
      node.title.forEach(n => n.accept(this));
      this._write('</h2>');
      if (this.pretty) this._write('\n');
    }
    node.blocks.forEach(b => b.accept(this));
    if (this.pretty) this._write('\n');
    this._write('</section>');
    if (this.pretty) this._write('\n');
  }

  /**
   * 公式：行内 <span class="math-inline">，块级 <div class="math">。
   * mathRenderer 选项存在时调用其渲染（返回 HTML 不转义），否则源码转义透传。
   * 内置 KaTeX 渲染结果按 (inline, 源码) 缓存，跨实例复用。
   * 块级公式带 caption 时包 <figure>（与图片一致）。
   */
  visit_Equation(node) {
    this._hasMath = true;
    let html;
    if (this._mathRendererCustom) {
      html = this._mathRenderer(node.source, node.inline);
    } else {
      const key = `${node.inline ? 'i' : 'b'}|${node.source}`;
      html = cacheGet(MATH_CACHE, key);
      if (html === undefined) {
        html = cacheSet(MATH_CACHE, key, this._mathRenderer(node.source, node.inline));
      }
    }
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : '';
    if (node.inline) {
      this._write(`<span class="math-inline"${id}>${html}</span>`);
      return;
    }
    if (node.caption.length) {
      const ref = this._refs[node.label];
      const num = ref ? ref.number : '';
      this._writeFigure(id, `<div class="math">${html}</div>`, node.caption, this._captionPrefix.eq, num);
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

  /** 行内容器（strong/em/del/sup/sub）：包裹并递归内容 */
  _writeInline(tag, node) {
    this._write(`<${tag}>`);
    node.content.forEach(n => n.accept(this));
    this._write(`</${tag}>`);
  }

  visit_Bold(node) { this._writeInline('strong', node); }
  visit_Italic(node) { this._writeInline('em', node); }
  visit_Strikethrough(node) { this._writeInline('del', node); }

  visit_InlineCode(node) {
    this._write(`<code>${this._esc(node.code)}</code>`);
  }

  visit_Link(node) {
    this._write(`<a href="${this._escAttr(safeLinkUrl(node.url))}">${this._esc(node.text)}</a>`);
  }

  visit_Image(node) {
    const w = node.width ? ` width="${node.width}"` : '';
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : '';
    // referrerpolicy="no-referrer": 绕过源站 Referer 防盗链
    this._write(`<img src="${this._escAttr(safeImageUrl(node.url))}" alt="${this._escAttr(node.alt)}"${w}${id} referrerpolicy="no-referrer">`);
  }

  visit_FunctionCall(node) {
    if (node.error) {
      // 错误注释附原文（AI 可从注释看到生成内容的原貌并自我修正）
      const raw = node.rawArgs ? `@${node.name}(${node.rawArgs})` : `@${node.name}`;
      this._write(`<!-- mslang: 参数解析错误 @${node.name}: ${this._esc(node.error)} | 原文: ${this._esc(raw)} -->`);
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

    // 宏展开：@use 返回的模板字符串（含行内语法）二次解析后渲染；
    // 递归深度防护（宏模板内嵌 @use 自引用 → 超限输出占位，防无限递归）
    if (node.name === 'use' && typeof result === 'string') {
      if (this._useDepth >= MAX_MACRO_DEPTH) {
        this._write('<!-- mslang: 宏递归超限（@use 嵌套过深） -->');
        return;
      }
      this._useDepth++;
      parseInlineFragment(result).forEach(n => n.accept(this));
      this._useDepth--;
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

  visit_Superscript(node) { this._writeInline('sup', node); }

  visit_Subscript(node) { this._writeInline('sub', node); }

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

  /** 文档含公式/高亮代码块时返回内联 CSS <style>（置于 wrapper 外；自定义渲染器/无样式需求时不内联） */
  _inlineStyles() {
    let out = '';
    if (this._hasMath && !this._mathRendererCustom && katexCss) {
      const fontsPath = this._mathFontsPath || KATEX_FONTS_CDN;
      const css = katexCss.replace(/url\(fonts\//g, `url(${fontsPath}`);
      out += `<style>${css}</style>\n`;
    }
    if (this._hasHighlight && highlightCss) {
      out += `<style>${highlightCss}</style>\n`;
    }
    return out;
  }

  _write(text) { this._output.push(text); }

  _esc(text) {
    if (this.escapeHtml) return escapeHTML(text);
    return text;
  }

  /** 属性值恒转义（不受 escapeHtml 控制：防注入，正文透传语义不受影响） */
  _escAttr(text) {
    return escapeAttr(text);
  }
}

/**
 * 将 check issues 转为面向 LLM 的自查文本（喂回模型定位修复用）。
 * @param {Array<{type: string, key: string, count: number, block?: number}>} issues
 * @returns {string}
 */
export function llmReport(issues) {
  const LABELS = {
    missing_cite: '引用了不存在的文献',
    missing_term: '引用了不存在的术语',
    missing_ref: '引用了不存在的交叉引用标签',
    missing_footnote: '引用了未定义的脚注',
    duplicate_label: '重复声明了标签',
    orphan_caption: '孤立 caption（未归并到目标块）',
    missing_include: 'include 加载失败（文档缺失）',
    missing_part: '引用了不存在的 part（@part 区间）',
  };
  if (!issues || !issues.length) return '检查通过：无引用缺口。';
  const lines = issues.map((i) => {
    const pos = i.block !== undefined ? `块 ${i.block}` : '文档';
    const n = i.count > 1 ? `（出现 ${i.count} 次）` : '';
    return `- ${pos}：${LABELS[i.type] || i.type}「${i.key}」${n}`;
  });
  return `发现 ${issues.length} 类问题：\n${lines.join('\n')}`;
}

/**
 * 对比两次 renderBlocks 的 blockHashes，返回内容变化的块（含 'footnotes'）。
 * 宿主流程：编辑块 → 重渲全文档 → diffBlocks(旧, 新) → 只替换变化块的 DOM。
 * @param {Object} oldHashes
 * @param {Object} newHashes
 * @returns {Array<number|string>} 变化块索引（数字），'footnotes' 表示脚注区变化
 */
export function diffBlocks(oldHashes, newHashes) {
  const keys = new Set([...Object.keys(oldHashes || {}), ...Object.keys(newHashes || {})]);
  return [...keys]
    .filter((k) => (oldHashes || {})[k] !== (newHashes || {})[k])
    .map((k) => (k === 'footnotes' ? k : Number(k)))
    .sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a).localeCompare(String(b));
    });
}

/**
 * 将 PreparedDocument 的诊断合并为公共 issues（check 模式）：
 * include 层（prepared.issues 为 legacy {type,key,count,block}）+ checkIntegrity
 * （code 转 legacy type）。Renderer 不自行 analyze，只消费 prepared。
 * @param {{issues: Array, document: Object, runtime: Object, semantic: Object}} prepared
 * @param {HTMLRenderer} _renderer - 保留（签名稳定）
 * @returns {Array<{type: string, key: string, count: number, block: number}>}
 */
export function toLegacyIssues(prepared, _renderer) {
  const fromDiag = checkIntegrity(prepared.document, prepared.runtime, prepared.semantic)
    .map((d) => ({
      type: DIAG_ISSUE_TYPE[d.code] || d.code,
      key: d.data.label,
      count: d.count,
      block: d.block,
    }));
  return [...((prepared.issues || [])), ...fromDiag];
}

export { HTMLRenderer, escapeHTML, escapeAttr };
