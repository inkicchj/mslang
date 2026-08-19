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

import { Lexer } from './lexer.js';
import { Parser, mergeDocuments, parseInlineFragment } from './parser.js';
import { evaluate } from './expression.js';
import { builtinFunctions, extractHeadingNumber } from './builtin.js';
import { escapeHTML, escapeAttr } from './escape.js';
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

// @set 白名单中"简单字符串选项"：key → 实例字段与默认值（_mergeSet 数据驱动用）
const SET_STRING_KEYS = {
  refNumbering: { field: '_refNumbering', def: '' },
  citeStyle: { field: '_citeStyle', def: 'numeric' },
  bibStyle: { field: '_bibStyle', def: 'default' },
  citeKeyAttr: { field: '_citeKeyAttr', def: '' },
  termKeyAttr: { field: '_termKeyAttr', def: '' },
  refKeyAttr: { field: '_refKeyAttr', def: '' },
};

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
    const doc = this._prepare(source, opts);
    doc.accept(this);
    const body = this._output.join('');
    const html = this._inlineStyles() + this._wrap(body, opts);
    if (opts.check) return { html, issues: this._checkIntegrity(doc) };
    return html;
  }

  /**
   * 单块渲染（块级编辑闭环）：_prepare 全量收集编号上下文后只渲染第 index 块。
   * 返回该块的 HTML（无 wrapper/哨兵），宿主替换对应 DOM 即可。
   * @param {string|Document} source
   * @param {number} index - 块索引（与 Parser.parseText(source).blocks 对齐）
   * @param {object} [opts] - 与 render() 相同（blocks/check 选项忽略）
   * @returns {string}
   */
  renderBlock(source, index, opts = {}) {
    const doc = this._prepare(source, opts);
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
    const doc = this._prepare(source, { ...opts, blockMarkers: true });
    doc.accept(this);
    const body = this._output.join('');
    const out = {
      html: this._inlineStyles() + this._wrap(body, opts),
      blockHashes: this._blockHashes,
    };
    if (opts.check) out.issues = this._checkIntegrity(doc);
    return out;
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
    const doc = this._prepare(source, opts);
    this._asyncSlots = [];
    this._asyncId = 0;
    doc.accept(this);
    await Promise.all(this._asyncSlots.map(s => s.promise));
    let body = this._output.join('');
    for (const slot of this._asyncSlots) {
      body = body.split(slot.token).join(slot.html);
    }
    const html = this._inlineStyles() + this._wrap(body, opts);
    if (opts.check) return { html, issues: this._checkIntegrity(doc) };
    return html;
  }

  /**
   * 渲染多个文档的合并结果：跨文档连续编号、交叉引用、全局 @set。
   * @param {(string|Document)[]} sources - mslang 文本或 Document，顺序即编号顺序
   * @param {object} [opts] - 与 render() 相同
   * @returns {string}
   */
  renderAll(sources, opts = {}) {
    const docs = sources.map(s => this._parseDoc(s));
    const merged = mergeDocuments(...docs);
    // blocks 选项转发：多文档合并的块级渲染（跨文档连续编号 + 哨兵）
    if (opts.blocks) return this.renderBlocks(merged, opts);
    return this.render(merged, opts);
  }

  /** 异步版 renderAll，语义与 renderAsync 相同 */
  async renderAllAsync(sources, opts = {}) {
    const docs = sources.map(s => this._parseDoc(s));
    const merged = mergeDocuments(...docs);
    if (opts.blocks) return this.renderBlocks(merged, opts);
    return this.renderAsync(merged, opts);
  }

  /** 渲染管线公共部分：选项应用 + 解析 + 预扫描 + 编号收集（render / renderAsync 共用） */
  _prepare(source, opts) {
    this._applyOpts(opts);
    const doc = this._parseDoc(source);
    this._applySets(doc);
    this._collectRefs(doc);
    return doc;
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
      mathFontsPath = '',
      codeRenderer = null,
      citeStyle = 'numeric',
      bibStyle = 'default',
      allowPlugins = true,
      blockMarkers = false,
    } = opts;
    this._data = data || {};
    this._variables = variables || {};
    this._macros = {};
    this._headingNumbering = headingNumbering === true ? '1.1' : (headingNumbering || '');
    this._refNumbering = refNumbering || '';
    this._captionPrefix = HTMLRenderer._mergeCaptionPrefix(HTMLRenderer.DEFAULT_CAPTION_PREFIX, captionPrefix);
    this._citeKeyAttr = citeKeyAttr || '';
    this._termKeyAttr = termKeyAttr || '';
    this._refKeyAttr = refKeyAttr || '';
    // mathRenderer 默认使用内置 KaTeX 渲染（可传选项覆盖）
    this._mathRenderer = mathRenderer || ((src, inline) =>
      katex.renderToString(src, { displayMode: !inline, throwOnError: false }));
    this._mathFontsPath = mathFontsPath || '';
    this._codeRenderer = codeRenderer || null;
    this._citeStyle = citeStyle || 'numeric';
    this._bibStyle = bibStyle || 'default';
    this._allowPlugins = allowPlugins !== false;
    this._blockMarkers = blockMarkers === true;
    this._blockHashes = {};
    this._evalCtx = { functions: this._functions, variables: this._variables };
    this._output = [];
    this._asyncSlots = null;
    this._hasMath = false;
    this._mathRendererCustom = !!mathRenderer;
    this._termOrder = [];
    this._hasHighlight = false;
    this._pluginCache = new Map();
  }

  /** 解析输入为 Document（render / renderAsync 共用）；Document 输入直接使用（无源区间） */
  _parseDoc(source) {
    return source instanceof Document
      ? source
      : new Parser().parse(new Lexer(source).tokenize(), source);
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
  static SET_KEYS = ['headingNumbering', 'refNumbering', 'escapeHtml', 'pretty', 'data', 'variables', 'terms', 'bibliography', 'captionPrefix', 'citeKeyAttr', 'termKeyAttr', 'refKeyAttr', 'citeStyle', 'allowPlugins', 'bibStyle'];

  // 引用/术语 data 属性名（工作台交互定位用；空串关闭）
  static DEFAULT_KEY_ATTRS = { citeKeyAttr: 'data-cite-key', termKeyAttr: 'data-term-key', refKeyAttr: 'data-ref-label' };

  // caption 前缀（默认中文，可用 @set 覆盖；thm 按定理类型细分）
  static DEFAULT_CAPTION_PREFIX = {
    fig: '图', tbl: '表', eq: '式',
    thm: { theorem: '定理', lemma: '引理', definition: '定义', remark: '注记', example: '例' },
  };

  /** 深合并 captionPrefix（thm 为嵌套对象，避免浅合并整体覆盖） */
  static _mergeCaptionPrefix(base, incoming) {
    const cp = incoming || {};
    return {
      ...base,
      ...cp,
      thm: { ...(base.thm || {}), ...(cp.thm || {}) },
    };
  }

  /**
   * 预扫描文档顶层的 @set({...}) 调用并应用配置。
   * 必须在 _collectRefs 之前执行，使编号计算使用最终配置。
   * @set 全文档生效（建议放文档开头），仅识别块级内容中的顶层调用。
   */
  /**
   * 遍历单个块的全部行内节点（content/items/children，递归穿过行内容器）。
   * _eachInline 与 _collectRefs 共用，顺序与渲染顺序一致。
   */
  _eachBlockInline(block, fn) {
    const walk = (inlines) => {
      for (const n of inlines) {
        fn(n);
        if (n.content) walk(n.content);
        if (n.caption) walk(n.caption);
        if (n.title) walk(n.title); // Theorem 标题行内节点
      }
    };
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

  /** 遍历块数组的行内节点（PartBlock 递归进内部块） */
  _eachBlocksInline(blocks, fn) {
    for (const b of blocks) {
      if (b instanceof PartBlock) { this._eachBlocksInline(b.blocks, fn); continue; }
      this._eachBlockInline(b, fn);
    }
  }

  _applySets(doc) {
    this._eachBlocksInline(doc.blocks, (n) => {
      if (n instanceof FunctionCall && n.name === 'set') this._applySet(n);
      else if (n instanceof FunctionCall && n.name === 'let') this._applyLet(n);
      else if (n instanceof FunctionCall && n.name === 'plugin') this._applyPlugin(n);
      else if (n instanceof FunctionCall && n.name === 'define') this._applyDefine(n);
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

  /**
   * 预扫描注册 @plugin 声明的函数（与 @set/@let 同步执行）。
   * 编译失败/未开启时忽略，渲染阶段由函数调用输出错误注释。
   */
  _applyPlugin(node) {
    if (node.error || node.args.length < 2) return;
    try {
      const name = evaluate(node.args[0], this._evalCtx);
      const body = evaluate(node.args[1], this._evalCtx);
      if (typeof name === 'string' && typeof body === 'string') this._registerPlugin(name, body);
    } catch (e) {
      // 求值失败忽略（如参数非字面量）
    }
  }

  /**
   * 预扫描注册 @define 声明的宏（与 @set/@let/@plugin 同步执行）。
   * 模板为含 {key} 占位符的 mslang 行内片段，渲染时 @use 展开并二次解析。
   */
  _applyDefine(node) {
    if (node.error || node.args.length < 2) return;
    try {
      const name = evaluate(node.args[0], this._evalCtx);
      const template = evaluate(node.args[1], this._evalCtx);
      if (typeof name === 'string' && typeof template === 'string') {
        this._macros[name] = template;
      }
    } catch (e) {
      // 求值失败忽略（如参数非字面量），渲染阶段由 use 输出错误注释
    }
  }

  /**
   * 插件编译注册：new Function 编译函数表达式（全局作用域，签名与内置一致 ...args, kwargs）。
   * 同 body 编译缓存；allowPlugins 关闭时不注册。
   */
  _registerPlugin(name, body) {
    if (!this._allowPlugins) return;
    let fn = this._pluginCache.get(body);
    if (fn === undefined) {
      try {
        fn = new Function(`return (${body});`)();
      } catch (e) {
        fn = null; // 编译失败：调用时输出错误注释
      }
      this._pluginCache.set(body, fn);
    }
    if (typeof fn === 'function') this._functions[name] = fn;
  }

  /** 白名单合并：@set 覆盖同名选项；terms/bibliography 增量合并（可多次设置） */
  _mergeSet(config) {
    for (const key of HTMLRenderer.SET_KEYS) {
      if (!(key in config)) continue;
      const v = config[key];
      if (key === 'data' || key === 'terms' || key === 'bibliography') {
        // data 深合并；terms/bibliography 为 data 内联快捷（等价）
        this._data = this._mergeData(this._data, key === 'data' ? v : { [key]: v });
      } else if (key === 'variables') {
        // 就地合并（不替换对象）：保持 _evalCtx.variables 引用有效
        Object.assign(this._variables, v || {});
      } else if (key === 'captionPrefix') {
        this._captionPrefix = HTMLRenderer._mergeCaptionPrefix(this._captionPrefix, v);
      } else if (key === 'allowPlugins') {
        this._allowPlugins = v !== false;
      } else if (key === 'headingNumbering') {
        this._headingNumbering = v === true ? '1.1' : (v || '');
      } else if (key in SET_STRING_KEYS) {
        const { field, def } = SET_STRING_KEYS[key];
        this[field] = v || def;
      } else {
        // escapeHtml / pretty（布尔开关，直接赋实例属性）
        this[key] = v;
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
    const counters = { fig: 0, tbl: 0, sec: 0, eq: 0, thm: 0 };

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

    // 当前块的渲染依赖（块级编辑哈希：变量/宏/data 变化 → 引用块哈希变）
    let currentDeps = null;

    // 表达式树中的 cite/term/use 调用（嵌套于 if 等函数参数；顶层 FunctionCall 由 walkInlineList 处理）
    const handleCall = (call) => {
      if (call.name === 'cite') {
        for (const a of call.args) {
          if (a.type !== 'string') continue;
          this._registerCite(a.value);
          const entry = this._data.bibliography && this._data.bibliography[a.value];
          if (entry !== undefined) (currentDeps.d.cite ||= {})[a.value] = entry;
        }
      }
      if (call.name === 'term' && call.args[0] && call.args[0].type === 'string') {
        this._registerTerm(call.args[0].value);
        const entry = this._data.terms && this._data.terms[call.args[0].value];
        if (entry !== undefined) (currentDeps.d.term ||= {})[call.args[0].value] = entry;
      }
      if (call.name === 'use' && call.args[0] && call.args[0].type === 'string') {
        const t = this._macros[call.args[0].value];
        if (t !== undefined) currentDeps.m[call.args[0].value] = t;
      }
      // 文献表/术语表块依赖对应数据全量（条目内容变化 → 表输出变）
      if (call.name === 'bibliography') currentDeps['bib-all'] = this._data.bibliography;
      if (call.name === 'glossary') currentDeps['term-all'] = this._data.terms;
    };

    // 行内节点处理（递归由 _eachBlockInline 负责）
    const walkInlineList = (n) => {
      if (n instanceof Image && n.label) {
        counters.fig++;
        this._refs[n.label] = { kind: 'fig', number: counters.fig };
      }
      if (n instanceof FunctionCall) {
        handleCall(n);
        n.args.forEach(a => this._walkExprTree(a, handleCall, (v) => {
          if (v.name in this._variables) currentDeps.v[v.name] = this._variables[v.name];
        }));
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

    // 单一遍历：块 → 块内行内，顺序与渲染一致（fig 编号 Image/mermaid 共享）
    // PartBlock 递归进内部块（内部标题/图/表/式/定理照常收集编号）
    const collectBlock = (block) => {
      // 渲染依赖收集容器（块级编辑哈希：变量/宏/data 变化 → 引用块哈希变）
      const deps = { v: {}, m: {}, d: {} };
      block._deps = deps;
      currentDeps = deps;
      // 块渲染时的编号前缀快照（块级编辑哈希：块 i 之后编号变化 → 后续块哈希变）
      block._prefixCounts = {
        fig: counters.fig, tbl: counters.tbl, sec: counters.sec, eq: counters.eq, thm: counters.thm,
        cite: this._citeOrder.length, term: this._termOrder.length,
      };
      if (block instanceof PartBlock) {
        if (block.id) {
          const text = headingText(block.title) || block.id;
          // part 引用显示标题全文（可被 refNumbering 提取数字前缀，与标题同规则）
          let display;
          if (this._refNumbering) display = extractHeadingNumber(text, this._refNumbering);
          if (display === undefined) display = text;
          this._refs[block.id] = { kind: 'part', display };
        }
        block.blocks.forEach(collectBlock);
        return;
      }
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
      if (block instanceof CodeBlock && block.label && block.language === 'mermaid') {
        // mermaid 流程图与图片共享 fig 编号序列
        counters.fig++;
        this._refs[block.label] = { kind: 'fig', number: counters.fig };
      }
      if (block instanceof Theorem && block.label) {
        // 定理/引理/定义共享编号序列，type 用于显示前缀
        counters.thm++;
        this._refs[block.label] = { kind: 'thm', type: block.type, number: counters.thm };
      }
      if (block.content || block.items) this._eachBlockInline(block, walkInlineList);
    };
    doc.blocks.forEach(collectBlock);
    currentDeps = null;

    // author-year 样式消歧：同年同作者按引用顺序加 a/b/c 后缀（收集完成后计算，cite/bibliography 共用）
    this._citeYearSuffix = {};
    if (this._citeStyle !== 'numeric') {
      const counts = {};
      for (const key of this._citeOrder) {
        const entry = this._data.bibliography && this._data.bibliography[key];
        if (!entry || typeof entry !== 'object' || !entry.authors || entry.year === undefined) continue;
        const g = `${String(entry.authors).toLowerCase()}|${entry.year}`;
        counts[g] = (counts[g] || 0) + 1;
      }
      const seen = {};
      for (const key of this._citeOrder) {
        const entry = this._data.bibliography && this._data.bibliography[key];
        if (!entry || typeof entry !== 'object' || !entry.authors || entry.year === undefined) continue;
        const g = `${String(entry.authors).toLowerCase()}|${entry.year}`;
        const idx = (seen[g] = (seen[g] || 0) + 1);
        this._citeYearSuffix[key] = counts[g] > 1 ? String.fromCharCode(96 + idx) : '';
      }
    }
  }

  /**
   * 引用完整性检查（opts.check 时）：检测缺失的文献/术语/交叉引用/脚注定义、
   * 重复标签、孤立 caption。按 type+key 去重并计数，附带首次出现的块索引。
   * _refs 需在 _collectRefs 之后（前向引用已完整）。
   * @param {Document} doc
   * @returns {Array<{type: string, key: string, count: number, block: number}>}
   */
  _checkIntegrity(doc) {
    const issues = [];
    const seen = new Map();
    const seenLabels = new Set();
    let currentBlock = -1;
    const report = (type, key) => {
      const id = `${type}|${key}`;
      if (seen.has(id)) issues[seen.get(id)].count++;
      else { seen.set(id, issues.length); issues.push({ type, key, count: 1, block: currentBlock }); }
    };
    const handleCall = (call) => {
      if (call.name === 'cite') {
        for (const a of call.args) {
          if (a.type === 'string' && !(this._data.bibliography && this._data.bibliography[a.value])) {
            report('missing_cite', a.value);
          }
        }
      } else if (call.name === 'term') {
        const a = call.args[0];
        if (a && a.type === 'string' && !(this._data.terms && this._data.terms[a.value])) {
          report('missing_term', a.value);
        }
      } else if (call.name === 'ref') {
        const a = call.args[0];
        if (a && a.type === 'string' && !this._refs[a.value]) report('missing_ref', a.value);
      }
    };
    const markLabel = (label) => {
      if (!label) return;
      if (seenLabels.has(label)) report('duplicate_label', label);
      else seenLabels.add(label);
    };
    const walkInlineList = (n) => {
      // 顶层 FunctionCall（AST 节点，无 type 字段）；嵌套表达式由 _walkExprTree 处理
      if (n instanceof FunctionCall) {
        handleCall(n);
        n.args.forEach(a => this._walkExprTree(a, handleCall));
      }
      if (n instanceof FootnoteRef && !(n.label in doc.footnotes)) report('missing_footnote', n.label);
      if (n instanceof Image) markLabel(n.label);
    };
    const walkBlock = (block, blockIdx) => {
      currentBlock = blockIdx;
      if (block instanceof PartBlock) {
        markLabel(block.id);
        block.blocks.forEach(b => walkBlock(b, blockIdx));
        return;
      }
      // 块级 label（图/表/式/定理/mermaid 共享标签空间）
      if (block.label && (block instanceof Table || block instanceof Equation
        || block instanceof Theorem || (block instanceof CodeBlock && block.language === 'mermaid'))) {
        markLabel(block.label);
      }
      // 孤立 caption：降级时由 parser 标记（{#label} 行未归并到目标块）
      if (block._orphanCaption) report('orphan_caption', block._orphanCaption);
      if (block.content || block.items) this._eachBlockInline(block, walkInlineList);
    };
    doc.blocks.forEach((block, i) => walkBlock(block, i));
    currentBlock = -1;
    return issues;
  }

  /**
   * 将 issues 转为面向 LLM 的自查文本（喂回模型定位修复用）。
   * @param {Array<{type: string, key: string, count: number, block?: number}>} issues
   * @returns {string}
   */
  llmReport(issues) {
    return llmReport(issues);
  }

  /**
   * 遍历表达式树（嵌套在函数参数中的 call/var/unary/binary/object/array），
   * 对每个 call 节点调用 onCall、每个变量节点调用 onVar。
   * _collectRefs / _checkIntegrity 共用。
   * @param {object} node
   * @param {function} [onCall]
   * @param {function} [onVar]
   */
  _walkExprTree(node, onCall, onVar) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'call') {
      if (onCall) onCall(node);
      node.args.forEach(a => this._walkExprTree(a, onCall, onVar));
      Object.values(node.kwargs).forEach(a => this._walkExprTree(a, onCall, onVar));
    } else if (node.type === 'var') {
      if (onVar) onVar(node);
    } else if (node.type === 'unary') {
      this._walkExprTree(node.operand, onCall, onVar);
    } else if (node.type === 'binary') {
      this._walkExprTree(node.left, onCall, onVar);
      this._walkExprTree(node.right, onCall, onVar);
    } else if (node.type === 'object') {
      Object.values(node.value).forEach(a => this._walkExprTree(a, onCall, onVar));
    } else if (node.type === 'array') {
      node.items.forEach(a => this._walkExprTree(a, onCall, onVar));
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

  /** 术语键收集：首次出现加入 _termOrder（_collectRefs 预收集与运行时 term 共用） */
  _registerTerm(name) {
    if (!this._termOrder.includes(name)) this._termOrder.push(name);
  }

  /** 文献条目格式化：字符串原样转义；default 拼接 "authors (year) title journal"；
   *  gbt7714 近似 "作者. 题名. 期刊, 年份."（GB/T 7714 风格点分隔，年份不带括号） */
  _formatBibEntry(entry) {
    if (typeof entry === 'string') return this._esc(entry);
    const e = entry || {};
    const title = e.title ? this._esc(String(e.title)) : '';
    const titleHtml = e.url
      ? `<a href="${this._escAttr(String(e.url))}">${title}</a>` : title;
    if (this._bibStyle === 'gbt7714') {
      const parts = [];
      if (e.authors) parts.push(this._esc(String(e.authors)));
      if (titleHtml) parts.push(`${titleHtml}${titleHtml.endsWith('.') ? '' : '.'}`);
      if (e.journal) parts.push(`${this._esc(String(e.journal))},`);
      if (e.year !== undefined) parts.push(`${this._esc(String(e.year))}.`);
      return parts.join(' ');
    }
    const parts = [];
    if (e.authors) parts.push(this._esc(String(e.authors)));
    if (e.year !== undefined) parts.push(`(${this._esc(String(e.year))})`);
    if (titleHtml) parts.push(titleHtml);
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
    const img = `<img src="${this._escAttr(image.url)}" alt="${this._escAttr(image.alt)}"${width} referrerpolicy="no-referrer">`;
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

    // 宏展开：@use 返回的模板字符串（含行内语法）二次解析后渲染
    if (node.name === 'use' && typeof result === 'string') {
      parseInlineFragment(result).forEach(n => n.accept(this));
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

export { HTMLRenderer, escapeHTML, escapeAttr };
