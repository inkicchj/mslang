/**
 * mslang 内置函数 (builtin)
 *
 * 论文写作常用内置函数：逻辑运算、文献引用、术语引用、交叉引用、文档配置。
 * 通过 HTMLRenderer 构造时注册到 _functions，可用 opts.functions 覆盖同名函数。
 * 依赖渲染器内部状态（_data / _variables / _refs / _citeNumbers 等），
 * 由 renderer.render(source, { data, variables }) 注入数据。
 */

import { escapeAttr } from './escape.js';

// ================================================================
// 显式编号提取（章节引用 @ref 用）
// ================================================================

// 数字层级（1.1.2）与中文编号（第一章 / 一、 / （一））
const RE_NUM_ARABIC = /^(\d+(?:\.\d+)*)/;
const RE_NUM_CN = /^(第[一二三四五六七八九十百]+[章节篇]|[一二三四五六七八九十百]+[、．.]|（[一二三四五六七八九十百]+）|\([一二三四五六七八九十百]+\))/;

/**
 * 从标题文本开头提取显式编号。
 * @param {string} text
 * @param {string} mode - '1' 数字编号 / '一' 中文编号
 * @returns {string|undefined} 提取到的编号（剥离尾随顿号/点），未匹配返回 undefined
 */
export function extractHeadingNumber(text, mode) {
  if (mode !== '1' && mode !== '一') return undefined;
  const re = mode === '1' ? RE_NUM_ARABIC : RE_NUM_CN;
  const m = text.match(re);
  if (!m) return undefined;
  let num = m[1];
  if (mode === '一') num = num.replace(/[、．.]+$/, '');
  return num;
}

// ================================================================
// 内置函数注册表
// ================================================================

/**
 * @param {import('./renderer.js').HTMLRenderer} renderer
 * @returns {Object<string, Function>}
 */
export function builtinFunctions(renderer) {
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

    /** 变量声明：@let("name", value)，无输出；变量全文档可见（预扫描注册） */
    let: (name, value) => {
      if (typeof name === 'string') renderer._variables[name] = value;
      return '';
    },

    /** 文献键是否存在（供 if 条件使用） */
    has_cite: (key) => !!(renderer._data.bibliography && renderer._data.bibliography[key]),

    /** 术语是否存在（供 if 条件使用） */
    has_term: (name) => !!(renderer._data.terms && renderer._data.terms[name]),

    /** 文献引用：按文档出现顺序自动编号；citeStyle 为 numeric（默认）输出上标 [n]，
     *  author-year / author 输出 (Doe, 2020a) 风格（缺 authors 时回退数字） */
    cite: (key) => {
      const entry = renderer._data.bibliography && renderer._data.bibliography[key];
      if (!entry) return `<sup>[${esc(String(key))}?]</sup>`;
      renderer._registerCite(key); // 收集阶段未覆盖的键（如变量参数）在此动态编号
      const num = renderer._citeNumbers[key];
      // 条目可定义 key 字段（如数据库主键）：data 属性输出条目 key，与引用名解耦
      const dataKey = entry && entry.key !== undefined ? entry.key : key;
      const keyAttr = renderer._citeKeyAttr
        ? ` ${renderer._citeKeyAttr}="${escapeAttr(String(dataKey))}"` : '';
      const anchor = `href="#cite-${num}" id="ref-cite-${num}"${keyAttr} data-cite-index="${num - 1}"`;
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
    },

    /** 交叉引用：图/表显示"图 N/表 N"（前缀随 captionPrefix 配置）；章节显示 显式编号 → 自动编号 → 标题全文 */
    ref: (label) => {
      const r = renderer._refs[label];
      if (!r) return `<a href="#${escAttr(String(label))}">[${esc(String(label))}?]</a>`;
      let text;
      if (r.kind === 'fig') text = `${renderer._captionPrefix.fig} ${r.number}`;
      else if (r.kind === 'tbl') text = `${renderer._captionPrefix.tbl} ${r.number}`;
      else if (r.kind === 'eq') text = `${renderer._captionPrefix.eq} ${r.number}`;
      else text = r.display;
      const keyAttr = renderer._refKeyAttr
        ? ` ${renderer._refKeyAttr}="${escapeAttr(String(label))}" data-ref-kind="${r.kind}"` : '';
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
        ? ` ${renderer._termKeyAttr}="${escapeAttr(String(dataKey))}"` : '';
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
