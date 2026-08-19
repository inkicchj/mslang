/**
 * runtime.js — 文档执行环境（mslang 0.2 拆分：runtime 层，不依赖 HTML）
 *
 * 职责：变量（@let）/ 函数（builtin + host + @plugin）/ 宏（@define）/
 * 数据（data: bibliography/terms）/ 文档配置（@set）的注册与求值环境。
 * 配置优先级：Host Options > Document @set > Defaults（hostConfig 锁）。
 * Renderer / SemanticAnalyzer 共用 RuntimeContext；builtin 仍由 Renderer 注入
 * （其渲染侧依赖 _esc/_escAttr 等在 Renderer）。
 */

import { evaluate } from './expression.js';

// @set 白名单：仅这些键可被文档内配置覆盖（document 层）
export const SET_KEYS = ['headingNumbering', 'refNumbering', 'escapeHtml', 'pretty', 'data', 'variables', 'terms', 'bibliography', 'captionPrefix', 'citeKeyAttr', 'termKeyAttr', 'refKeyAttr', 'citeStyle', 'allowPlugins', 'bibStyle'];

/** 安全配置：宿主显式设置（非 undefined）时文档 @set 不可覆盖（锁） */
const SECURE_KEYS = ['allowPlugins'];

// 简单字符串配置：key → { def }（mergeSet 数据驱动）
const SET_STRING_KEYS = {
  refNumbering: { def: '' },
  citeStyle: { def: 'numeric' },
  bibStyle: { def: 'default' },
  citeKeyAttr: { def: '' },
  termKeyAttr: { def: '' },
  refKeyAttr: { def: '' },
};

/** 非 @set 可改（渲染专用）字段默认值 */
const CONFIG_DEFAULTS = {
  headingNumbering: '',
  captionPrefix: {},
  escapeHtml: true,
  pretty: true,
  citeStyle: 'numeric',
  bibStyle: 'default',
  citeKeyAttr: 'data-cite-key',
  termKeyAttr: 'data-term-key',
  refKeyAttr: 'data-ref-label',
  allowPlugins: false, // 安全边界：文档内 @plugin 默认关闭（宿主显式 allowPlugins:true 开启）
};

export function mergeCaptionPrefix(base, incoming) {
  const cp = incoming || {};
  return { ...base, ...cp, thm: { ...(base.thm || {}), ...(cp.thm || {}) } };
}

/** 引用/术语 data 属性名默认值 + caption 前缀默认（中文，thm 按定理类型细分） */
export const DEFAULT_KEY_ATTRS = {
  citeKeyAttr: 'data-cite-key',
  termKeyAttr: 'data-term-key',
  refKeyAttr: 'data-ref-label',
};

export const DEFAULT_CAPTION_PREFIX = {
  fig: '图', tbl: '表', eq: '式',
  thm: { theorem: '定理', lemma: '引理', definition: '定义', remark: '注记', example: '例' },
};

export class RuntimeContext {
  /** @param {{functions?: object, escapeHtml?: boolean, pretty?: boolean}} [renderOpts] 渲染期固定项（构造后不随渲染重置） */
  constructor(renderOpts = {}) {
    this.functions = { ...(renderOpts.functions || {}) };
    this.escapeHtml = renderOpts.escapeHtml !== false;
    this.pretty = renderOpts.pretty !== false;
    this.resetHost({});
  }

  /** 每渲染生命周期重置：document 层归零，应用 host 配置（host 优先于 @set）。
   *  escapeHtml/pretty 为构造期固定（渲染 opts 不含它们，避免覆盖构造值） */
  resetHost(opts = {}) {
    this.hostConfig = { ...opts };
    this.variables = { ...(opts.variables || {}) };
    this.macros = {};
    this.data = { ...(opts.data || {}) };
    this.pluginCache = new Map();
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      if (key === 'escapeHtml' || key === 'pretty') continue; // 构造期固定（@set 可改）
      const v = key in opts ? opts[key] : CONFIG_DEFAULTS[key];
      this[key] = v === undefined ? CONFIG_DEFAULTS[key] : v;
    }
    // 归一化：headingNumbering 布尔 true 视为 '1.1'；allowPlugins 布尔
    if (this.headingNumbering === true) this.headingNumbering = '1.1';
    else this.headingNumbering = this.headingNumbering || '';
    this.allowPlugins = this.allowPlugins !== false;
    this.evalCtx = { functions: this.functions, variables: this.variables };
  }

  /** 注册自定义函数（builtin 由 Renderer 构造后注入，覆盖同名 host 函数） */
  registerFunction(name, fn) {
    this.functions[name] = fn;
  }

  /** 文档 @set 合并（白名单；安全键 allowPlugins 由宿主决定，文档不可覆盖/打开） */
  applySetConfig(config) {
    if (!config || typeof config !== 'object') return;
    for (const key of SET_KEYS) {
      if (!(key in config)) continue;
      // 安全键（当前 allowPlugins）：文档 @set 一律无效，仅宿主显式配置可开启
      if (SECURE_KEYS.includes(key)) continue;
      const v = config[key];
      if (key === 'data' || key === 'terms' || key === 'bibliography') {
        this.data = this.mergeData(this.data, key === 'data' ? v : { [key]: v });
      } else if (key === 'variables') {
        Object.assign(this.variables, v || {});
      } else if (key === 'captionPrefix') {
        this.captionPrefix = this.mergeCaptionPrefix(this.captionPrefix, v);
      } else if (key === 'headingNumbering') {
        this.headingNumbering = v === true ? '1.1' : (v || '');
      } else if (key in SET_STRING_KEYS) {
        this[key] = v || SET_STRING_KEYS[key].def;
      } else {
        this[key] = v;
      }
    }
  }

  /** 数据合并：一层深合并（terms/bibliography 按 key 合并），其余键整体替换 */
  mergeData(existing, incoming) {
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

  /** caption 前缀深合并（thm 为嵌套对象，避免浅合并整体覆盖） */
  mergeCaptionPrefix(base, incoming) {
    return mergeCaptionPrefix(base, incoming);
  }

  /** 预扫描应用 @set({...})（块级内容中的顶层调用；求值失败忽略） */
  applySet(node) {
    if (node.error || !node.args[0]) return;
    try {
      const config = evaluate(node.args[0], this.evalCtx);
      this.applySetConfig(config);
    } catch (e) {
      // 配置求值失败忽略，渲染阶段由 set 函数输出错误注释
    }
  }

  /** 预扫描应用 @let("name", value)：变量全文档可见；求值失败忽略 */
  applyLet(node) {
    if (node.error || node.args.length < 2) return;
    try {
      const name = evaluate(node.args[0], this.evalCtx);
      const value = evaluate(node.args[1], this.evalCtx);
      if (typeof name === 'string') this.variables[name] = value;
    } catch (e) {
      // 求值失败忽略（如依赖后文变量），渲染阶段按文档顺序再次尝试
    }
  }

  /** 预扫描应用 @plugin(name, body)：编译失败/未开启时忽略 */
  applyPlugin(node) {
    if (node.error || node.args.length < 2) return;
    try {
      const name = evaluate(node.args[0], this.evalCtx);
      const body = evaluate(node.args[1], this.evalCtx);
      if (typeof name === 'string' && typeof body === 'string') this.registerPlugin(name, body);
    } catch (e) {
      // 求值失败忽略（如参数非字面量）
    }
  }

  /** 预扫描应用 @define(name, template)：宏模板（含 {key} 占位符），@use 时展开 */
  applyDefine(node) {
    if (node.error || node.args.length < 2) return;
    try {
      const name = evaluate(node.args[0], this.evalCtx);
      const template = evaluate(node.args[1], this.evalCtx);
      if (typeof name === 'string' && typeof template === 'string') {
        this.macros[name] = template;
      }
    } catch (e) {
      // 求值失败忽略，渲染阶段由 use 输出错误注释
    }
  }

  /** 插件编译注册：new Function 编译（同 body 缓存）；allowPlugins 关闭时不注册 */
  registerPlugin(name, body) {
    if (!this.allowPlugins) return;
    let fn = this.pluginCache.get(body);
    if (fn === undefined) {
      try {
        fn = new Function(`return (${body});`)();
      } catch (e) {
        fn = null; // 编译失败：调用时输出错误注释
      }
      this.pluginCache.set(body, fn);
    }
    if (typeof fn === 'function') this.functions[name] = fn;
  }
}

export { SET_STRING_KEYS };