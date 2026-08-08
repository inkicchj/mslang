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

// 代码高亮语言子集（常用论文/脚本语言，控制体积）
const HLJS_LANGUAGES = { javascript, typescript, python, java, c, cpp, go, rust, bash, json, sql, xml, css, markdown };
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
    return this._inlineStyles() + this._wrap(body, opts);
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
    return {
      html: this._inlineStyles() + this._wrap(body, opts),
      blockHashes: this._blockHashes,
    };
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
    return this._inlineStyles() + this._wrap(body, opts);
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
      allowPlugins = true,
      blockMarkers = false,
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
    this._mathFontsPath = mathFontsPath || '';
    this._codeRenderer = codeRenderer || null;
    this._citeStyle = citeStyle || 'numeric';
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
  static SET_KEYS = ['headingNumbering', 'refNumbering', 'escapeHtml', 'pretty', 'data', 'variables', 'terms', 'bibliography', 'captionPrefix', 'citeKeyAttr', 'termKeyAttr', 'refKeyAttr', 'citeStyle', 'allowPlugins'];

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
   * 遍历单个块的全部行内节点（content/items/children，递归穿过行内容器）。
   * _eachInline 与 _collectRefs 共用，顺序与渲染顺序一致。
   */
  _eachBlockInline(block, fn) {
    const walk = (inlines) => {
      for (const n of inlines) {
        fn(n);
        if (n.content) walk(n.content);
        if (n.caption) walk(n.caption);
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

  /** 遍历文档全部块的行内节点 */
  _eachInline(doc, fn) {
    for (const block of doc.blocks) this._eachBlockInline(block, fn);
  }

  _applySets(doc) {
    this._eachInline(doc, (n) => {
      if (n instanceof FunctionCall && n.name === 'set') this._applySet(n);
      else if (n instanceof FunctionCall && n.name === 'let') this._applyLet(n);
      else if (n instanceof FunctionCall && n.name === 'plugin') this._applyPlugin(n);
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
      } else if (key === 'citeStyle') {
        this._citeStyle = config[key] || 'numeric';
      } else if (key === 'allowPlugins') {
        this._allowPlugins = config[key] !== false;
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
        if (node.name === 'term' && node.args[0] && node.args[0].type === 'string') {
          this._registerTerm(node.args[0].value);
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

    // 行内节点处理（递归由 _eachBlockInline 负责）
    const walkInlineList = (n) => {
      if (n instanceof Image && n.label) {
        counters.fig++;
        this._refs[n.label] = { kind: 'fig', number: counters.fig };
      }
      if (n instanceof FunctionCall) {
        // 顶层 @cite("key") / @term("name") 调用
        if (n.name === 'cite' && n.args[0] && n.args[0].type === 'string') {
          this._registerCite(n.args[0].value);
        }
        if (n.name === 'term' && n.args[0] && n.args[0].type === 'string') {
          this._registerTerm(n.args[0].value);
        }
        // 嵌套在参数表达式中的 cite/term
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

    // 单一遍历：块 → 块内行内，顺序与渲染一致（fig 编号 Image/mermaid 共享）
    for (const block of doc.blocks) {
      // 块渲染时的编号前缀快照（块级编辑哈希：块 i 之后编号变化 → 后续块哈希变）
      block._prefixCounts = {
        fig: counters.fig, tbl: counters.tbl, sec: counters.sec, eq: counters.eq,
        cite: this._citeOrder.length, term: this._termOrder.length,
      };
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
      if (block.content || block.items) this._eachBlockInline(block, walkInlineList);
    }

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
      if (this._blockMarkers) {
        this._write(`<!--mslang:${i}-->\n`);
        this._blockHashes[i] = djb2(`${block.raw || ''}|${JSON.stringify(block._prefixCounts || {})}`);
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

  _escAttr(text) {
    if (this.escapeHtml) return escapeAttr(text);
    return text;
  }
}

export { HTMLRenderer, escapeHTML, escapeAttr };
