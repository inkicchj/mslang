/**
 * mslang 内置函数 (builtin)
 *
 * 拆分为两族（mslang 0.2.1）：
 *   - runtimeBuiltins(runtime)：纯执行环境函数（if/not/and/or、文档配置 set/let/define/use/
 *     plugin、存在性 has_cite/has_term），只操作 RuntimeContext，完全不知道 Renderer。
 *   - htmlBuiltins(renderer)：HTML 输出函数（cite/ref/term/bibliography/glossary），
 *     依赖 Renderer 的转义/语义状态/格式辅助。
 * host functions 优先级 > builtin：RuntimeContext 构造时先注册 runtimeBuiltins 再合并 host，
 * Renderer 构造时以 host/runtime 覆盖 htmlBuiltins（保持 host 可覆盖 cite/ref 等既有行为）。
 */

import { extractHeadingNumber } from './numbering.js';

// 兼容导出（0.2.1 起实现在 numbering.js；语义层已直接 import numbering）
export { extractHeadingNumber };

// ================================================================
// Runtime builtins（无 HTML，注册进 RuntimeContext）
// ================================================================

/**
 * @param {import('./runtime.js').RuntimeContext} runtime
 * @returns {Object<string, Function>}
 */
export function runtimeBuiltins(runtime) {
  return {
    if: (cond, then, els) => (cond ? then : (els === undefined ? '' : els)),
    not: (x) => !x,
    and: (...xs) => xs.every(Boolean),
    or: (...xs) => xs.some(Boolean),

    /** 文档内配置：@set({ headingNumbering: '1.1', ... })，无输出 */
    set: (config) => {
      if (config && typeof config === 'object') runtime.applySetConfig(config);
      return '';
    },

    /** 论文元数据：@meta({title, authors, keywords, ...})，无输出（0.3 已归并到 document.meta） */
    meta: () => '',

    /** 宏定义：@define("name", "模板")，无输出（预扫描注册，渲染时静默） */
    define: () => '',

    /** 宏展开：@use("name", { key: value }) 替换模板 {key} 占位符后按行内语法渲染。
     *  值按 mslang 字面转义（模板内 md 语法仍生效，值原样显示）；未定义宏抛错。 */
    use: (name, kwargs) => {
      const template = runtime.macros && runtime.macros[name];
      if (typeof template !== 'string') throw new Error(`undefined macro '${name}'`);
      const escMd = (v) => String(v).replace(/([*_~`^$[\]@<>!\\])/g, '\\$1');
      const kwargsObj = kwargs && typeof kwargs === 'object' ? kwargs : {};
      return template.replace(/\{([^{}]+)\}/g, (m, k) => (k in kwargsObj ? escMd(kwargsObj[k]) : m));
    },

    /** 插件注册：@plugin("name", "(args, kwargs) => ...")，无输出（安全边界：allowPlugins 默认 false） */
    plugin: (name, body) => {
      if (typeof name === 'string' && typeof body === 'string') runtime.registerPlugin(name, body);
      return '';
    },

    /** 变量声明：@let("name", value)，无输出；变量全文档可见（预扫描注册） */
    let: (name, value) => {
      if (typeof name === 'string') runtime.variables[name] = value;
      return '';
    },

    /** 文献键是否存在（供 if 条件使用） */
    has_cite: (key) => !!(runtime.data.bibliography && runtime.data.bibliography[key]),

    /** 术语是否存在（供 if 条件使用） */
    has_term: (name) => !!(runtime.data.terms && runtime.data.terms[name]),
  };
}

// ================================================================
// HTML builtins（依赖 Renderer 转义/语义/格式；经 renderer.runtime.functions 注入）
// ================================================================

/**
 * @param {import('./renderer.js').HTMLRenderer} renderer
 * @returns {Object<string, Function>}
 */
export function htmlBuiltins(renderer) {
  const esc = (t) => renderer._esc(t);
  const escAttr = (t) => renderer._escAttr(t);

  /** 引用锚点属性（文献编号 + data 元数据） */
  const citeAnchor = (key, entry, num) => {
    const dataKey = entry && entry.key !== undefined ? entry.key : key;
    const keyAttr = renderer._citeKeyAttr
      ? ` ${renderer._citeKeyAttr}="${escAttr(String(dataKey))}"` : '';
    return `href="#cite-${num}" id="ref-cite-${num}"${keyAttr} data-cite-index="${num - 1}"`;
  };

  /** 单个文献引用渲染（numeric → 上标 [n]；author-year/author → (Doe, 2020a) 风格；
   *  CSL 模式（citation.style + 可用）→ citeproc 文本，缺 authors 回退数字） */
  const renderCiteOne = (key) => {
    const entry = renderer._data.bibliography && renderer._data.bibliography[key];
    if (!entry) return `<sup>[${esc(String(key))}?]</sup>`;
    renderer._registerCite(key); // 收集阶段未覆盖的键（如变量参数）在此动态编号
    const num = renderer._citeNumbers[key];
    const anchor = citeAnchor(key, entry, num);
    // CSL 模式：cite 文本交 CitationEngine（格式化职责收口到 citation.js）
    if (renderer.citation.enabled) {
      const text = renderer.citation.formatCitation([key], { bibliography: renderer._data.bibliography });
      return text ? `<a ${anchor}>(${esc(text)})</a>` : `<sup>[${esc(String(num))}]</sup>`;
    }
    if (renderer._citeStyle !== 'numeric') {
      const authors = entry && entry.authors ? String(entry.authors) : '';
      if (authors) {
        const suffix = renderer._citeYearSuffix && renderer._citeYearSuffix[key] || '';
        const year = renderer._citeStyle === 'author-year' && entry.year !== undefined
          ? `, ${entry.year}${suffix}` : '';
        return `<a ${anchor}>(${esc(authors)}${year})</a>`;
      }
    }
    return `<sup><a ${anchor}>[${esc(String(num))}]</a></sup>`;
  };

  return {
    /** 文献引用：支持一次引多篇 @cite("a","b","c")。
     *  numeric → 上标 [1-3]（连续区间合并）/[1,3]（非连续），逐 key 锚点（连续区间保留首尾）；
     *  author-year / author → (Doe, 2020a; Smith, 2019) 共享括号，分号分隔。 */
    cite: (...keys) => {
      // 渲染器调用时末尾附 kwargs 对象（无 kwargs 时为空对象），剔除
      if (keys.length && typeof keys[keys.length - 1] === 'object') keys = keys.slice(0, -1);
      if (keys.length === 1) return renderCiteOne(keys[0]);
      if (renderer.citation.enabled || renderer._citeStyle !== 'numeric') {
        const parts = keys.map((key) => {
          const entry = renderer._data.bibliography && renderer._data.bibliography[key];
          if (!entry) return `[${esc(String(key))}?]`;
          renderer._registerCite(key);
          const num = renderer._citeNumbers[key];
          const anchor = citeAnchor(key, entry, num);
          // CSL 模式：文本交 CitationEngine（formatCitation 收口）
          if (renderer.citation.enabled) {
            const text = renderer.citation.formatCitation([key], { bibliography: renderer._data.bibliography });
            return text ? `<a ${anchor}>${esc(text)}</a>` : `<sup><a ${anchor}>[${esc(String(num))}]</a></sup>`;
          }
          const authors = entry && entry.authors ? String(entry.authors) : '';
          if (!authors) return `<sup><a ${anchor}>[${esc(String(num))}]</a></sup>`;
          const suffix = renderer._citeYearSuffix && renderer._citeYearSuffix[key] || '';
          const year = renderer._citeStyle === 'author-year' && entry.year !== undefined
            ? `, ${entry.year}${suffix}` : '';
          return `<a ${anchor}>${esc(authors)}${year}</a>`;
        });
        return `(${parts.join('; ')})`;
      }
      const items = [];
      const missing = [];
      for (const key of keys) {
        const entry = renderer._data.bibliography && renderer._data.bibliography[key];
        if (!entry) { missing.push(key); continue; }
        renderer._registerCite(key);
        items.push({ key, entry, num: renderer._citeNumbers[key] });
      }
      items.sort((a, b) => a.num - b.num);
      // 连续编号合并为区间 [1-3]，非连续逗号分隔
      const groups = [];
      let cur = [];
      for (const it of items) {
        const last = cur[cur.length - 1];
        if (last && it.num === last.num + 1) cur.push(it);
        else { if (cur.length) groups.push(cur); cur = [it]; }
      }
      if (cur.length) groups.push(cur);
      const inner = groups.map((g) => {
        if (g.length === 1) {
          const { key, entry, num } = g[0];
          return `<a ${citeAnchor(key, entry, num)}>${num}</a>`;
        }
        const first = g[0];
        const last = g[g.length - 1];
        return `<a ${citeAnchor(first.key, first.entry, first.num)}>${first.num}</a>` +
               `-<a ${citeAnchor(last.key, last.entry, last.num)}>${last.num}</a>`;
      });
      return `<sup>[${inner.join(',')}${missing.length ? ',' + missing.map(k => esc(String(k)) + '?').join(',') : ''}]</sup>`;
    },

    /** 交叉引用：图/表显示"图 N/表 N"（前缀随 captionPrefix 配置）；章节显示 显式编号 → 自动编号 → 标题全文 */
    ref: (label) => {
      const r = renderer._refs[label];
      if (!r) return `<a href="#${escAttr(String(label))}">[${esc(String(label))}?]</a>`;
      let text;
      if (r.kind === 'fig') text = `${renderer._captionPrefix.fig} ${r.number}`;
      else if (r.kind === 'tbl') text = `${renderer._captionPrefix.tbl} ${r.number}`;
      else if (r.kind === 'eq') text = `${renderer._captionPrefix.eq} ${r.number}`;
      else if (r.kind === 'thm') text = `${(renderer._captionPrefix.thm && renderer._captionPrefix.thm[r.type]) || '定理'} ${r.number}`;
      else text = r.display;
      const keyAttr = renderer._refKeyAttr
        ? ` ${renderer._refKeyAttr}="${escAttr(String(label))}" data-ref-kind="${r.kind}"` : '';
      return `<a href="#${escAttr(String(label))}"${keyAttr}>${esc(text)}</a>`;
    },

    /** 文献表：列出全部被引用文献（按编号顺序），生成 <ol> 锚点与 cite 对应 */
    bibliography: () => {
      const items = renderer._citeOrder
        .map((key, i) => {
          const entry = renderer._data.bibliography && renderer._data.bibliography[key];
          if (entry === undefined) return null;
          return { key, index: i, entry };
        })
        .filter(x => x !== null);
      if (!items.length) return '';
      if (renderer._citeStyle !== 'numeric') {
        // author-year/author：按作者+年份排序（id 仍对应引用锚点）
        const sortKey = (x) => {
          const e = x.entry;
          const a = (typeof e === 'object' && e.authors ? String(e.authors) : '').toLowerCase();
          const y = (typeof e === 'object' && e.year !== undefined ? String(e.year) : '');
          return `${a}${y}`;
        };
        const sorted = [...items].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        const lis = sorted.map(({ index, entry }) =>
          `<li id="cite-${index + 1}">${renderer._formatBibEntry(entry)}</li>`).join('\n');
        return `<ul class="bibliography">\n${lis}\n</ul>`;
      }
      const lis = items.map(({ index, entry }) =>
        `<li id="cite-${index + 1}">${renderer._formatBibEntry(entry)}</li>`).join('\n');
      return `<ol class="bibliography">\n${lis}\n</ol>`;
    },

    /** 术语引用：字符串值为 label 简写；对象可带 label / url / key */
    term: (name, kwargs) => {
      renderer._registerTerm(name); // 收集阶段未覆盖的键（如变量参数）在此动态注册
      const entry = renderer._data.terms && renderer._data.terms[name];
      const label = typeof entry === 'string' ? entry : ((entry && entry.label) ? entry.label : name);
      const inner = `<span class="term">${esc(String(label))}</span>`;
      const url = (entry && typeof entry === 'object' && entry.url) ? entry.url : '';
      // 条目可定义 key 字段（如数据库主键）：data 属性输出条目 key，与引用名解耦
      const dataKey = entry && typeof entry === 'object' && entry.key !== undefined ? entry.key : name;
      const keyAttr = renderer._termKeyAttr
        ? ` ${renderer._termKeyAttr}="${escAttr(String(dataKey))}"` : '';
      return url
        ? `<a href="${escAttr(String(url))}"${keyAttr}>${inner}</a>`
        : `<span class="term"${keyAttr}>${esc(String(label))}</span>`;
    },

    /** 术语表：列出全部被引用术语（按首次出现顺序），label — desc（可选），url 可链接 */
    glossary: () => {
      const items = renderer._termOrder
        .map((name, i) => {
          const entry = renderer._data.terms && renderer._data.terms[name];
          if (entry === undefined) return null;
          const label = typeof entry === 'string' ? entry : ((entry && entry.label) ? entry.label : name);
          const desc = (entry && typeof entry === 'object' && entry.desc) ? String(entry.desc) : '';
          const text = desc ? `${esc(String(label))} — ${esc(desc)}` : esc(String(label));
          const url = (entry && typeof entry === 'object' && entry.url) ? entry.url : '';
          const inner = url ? `<a href="${escAttr(String(url))}">${text}</a>` : text;
          return `<li id="term-${i + 1}">${inner}</li>`;
        })
        .filter(Boolean);
      if (!items.length) return '';
      return `<ul class="glossary">\n${items.join('\n')}\n</ul>`;
    },
  };
}