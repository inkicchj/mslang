/**
 * citation.js — 引用格式化适配器（mslang 0.3）
 *
 * 边界（重构文档 0.3）：Semantic = meaning，Citation.js = formatting。
 * SemanticModel 负责"谁引用谁 / 出现顺序 / 缺失 / source span"；
 * CitationEngine 只负责文献数据标准化与 citation/bibliography 文本。
 * SemanticAnalyzer 完全不 import 本模块；Renderer 只调 this.citation.formatXxx(...)。
 *
 * 数据模型：同时接受 0.2 兼容模型（authors: string / journal / year）与 CSL-JSON
 * （author: [{family, given}] / issued: {"date-parts": [[2024]]} / container-title / type）。
 * 输出后端：内置 lightweight formatter（默认，保留 0.2 兼容）+ 自动探测 CSL
 * （@citation-js/core + @citation-js/plugin-csl，宿主装了就可用，未装回退 lightweight）。
 * 也可由宿主注入自定义 engine（options.citation.engine）。
 */

import { createRequire } from 'module';
import { safeLinkUrl } from './escape.js';

// ================================================================
// CSL 自动探测（Node createRequire 同步；浏览器宿主注入 engine）
// ================================================================

let _csl = null; // { Cite } | null（探测缓存）

/** 探测宿主是否已安装 @citation-js/core + plugin-csl（Node）；未安装返回 null */
export function detectCSL() {
  if (_csl !== null) return _csl;
  try {
    const core = createRequire(import.meta.url)('@citation-js/core');
    createRequire(import.meta.url)('@citation-js/plugin-csl'); // 插件副作用注册
    _csl = { Cite: core.Cite.bind ? core.Cite : core.Cite };
  } catch (e) {
    _csl = null;
  }
  return _csl;
}

// ================================================================
// 数据标准化：旧模型 + CSL-JSON → 内部标准
// ================================================================

/** CSL author 数组 → "Family, G."（单作者）/ "A, B and C"（多作者） */
export function formatAuthors(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.authors === 'string') return entry.authors;
  const list = Array.isArray(entry.author) ? entry.author : null;
  if (!list || !list.length) return '';
  const name = (a) => {
    if (typeof a === 'string') return a;
    if (!a) return '';
    // 中文姓名约定：name 或 family（given 空），保持原序；西文家族姓氏置前
    const family = a.family || a.name || '';
    const given = a.given || '';
    if (!given) return family;
    const hasCJK = /[\u4e00-\u9fff]/.test(`${family}${given}`);
    if (hasCJK) return `${family}${given}`;
    // "Doe, J."——given 取首字母，多词取双字母缩写（CSL 常见 "John Wayne" → "Wayne, J. W."）
    const initials = given.split(/[\s-]+/).map((w) => `${w[0] || ''}.`).join(' ');
    return `${family}, ${initials}`;
  };
  const names = list.map(name).filter(Boolean);
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** 年份提取：year 字段 > issued.date-parts[0][0]（CSL-JSON） */
export function entryYear(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.year !== undefined) return entry.year;
  const dp = entry.issued && entry.issued['date-parts'];
  if (Array.isArray(dp) && dp[0] && dp[0][0] !== undefined) return dp[0][0];
  return undefined;
}

/** 容器名（期刊/书名/文集）：container-title（CSL）> journal > booktitle > publisher */
export function entryContainer(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return entry['container-title'] || entry.journal || entry.booktitle || entry.publisher || '';
}

/** 任意条目模型 → 内部标准字段（供 lightweight formatter 消费） */
export function normalizeEntry(entry) {
  if (entry == null) return {};
  if (typeof entry === 'string') return { title: entry };
  return {
    id: entry.id || '',
    type: entry.type || '',
    authors: formatAuthors(entry),
    year: entryYear(entry),
    title: entry.title || '',
    container: entryContainer(entry),
    url: entry.URL || entry.url || '',
    doi: entry.DOI || '',
    volume: entry.volume,
    issue: entry.issue,
    page: entry.page,
  };
}

// ================================================================
// CSL 适配（@citation-js/core 驱动；每条独立格式化以保留锚点结构）
// ================================================================

/** 提取 CSL 单项格式化的 csl-entry 内部内容（剥离外层 div），失败回退原文 */
function cslEntryInner(html) {
  if (typeof html !== 'string') return html;
  const m = html.match(/class="csl-entry">([\s\S]*?)<\/div>/);
  return m ? m[1] : html;
}

/**
 * CSL 后端。构造一次仅绑定样式/locale；每条条目独立 Cite 格式化
 * （mslang 保留自己的编号/锚点结构，CSL 只提供文本）。
 */
export class CSLFormatter {
  /**
   * @param {{ Cite: Function }} core - @citation-js/core（已含 plugin-csl）
   * @param {string} [style] - CSL 样式名（'apa' | 'ieee' | ...）
   * @param {string} [locale] - 如 'en-US' / 'zh-CN'
   */
  constructor(core, style = 'apa', locale = 'en-US') {
    this.Cite = core.Cite;
    this.style = style;
    this.locale = locale;
  }

  /** 内联引用文本：@cite("a","b") → "(Smith, 2024; Doe, 2020)"（text 输出无括号则补括号）。
   *  opts.bare = true 时返回无括号文本（供逐 key 锚点外层统一加括号） */
  formatInline(entries, opts = {}) {
    const Cite = this.Cite;
    let txt;
    try {
      txt = new Cite(entries, { forceType: '@csl/list+object' }).format('citation', {
        format: 'text', template: this.style, lang: this.locale,
      });
    } catch (e) {
      return '';
    }
    const s = String(txt).trim();
    if (opts.bare) {
      return (s.startsWith('(') || s.startsWith('[') ? s.slice(1, -1) : s).trim();
    }
    return s.startsWith('(') || s.startsWith('[') ? s : `(${s})`;
  }

  /** 参考文献条目：单项 → csl-entry 内部 HTML（保留作者斜体等标签） */
  formatEntry(entry) {
    const Cite = this.Cite;
    let html;
    try {
      html = new Cite([entry], { forceType: '@csl/list+object' }).format('bibliography', {
        format: 'html', template: this.style, lang: this.locale,
      });
    } catch (e) {
      return '';
    }
    return cslEntryInner(html);
  }
}

// ================================================================
// CitationEngine（Renderer 的单一格式化入口）
// ================================================================

export class CitationEngine {
  /**
   * @param {{ style?: string, locale?: string, engine?: CSLFormatter }} opts
   *   style: CSL 样式名（提供即启用 CSL 后端；未提供时用内置 lightweight）
   *   engine: 宿主注入 CSLFormatter（替代自动探测）
   */
  constructor(opts = {}) {
    this.cslStyle = opts.style || null;
    this.locale = opts.locale || 'en-US';
    if (opts.engine instanceof CSLFormatter) {
      this.csl = opts.engine;
    } else if (opts.style) {
      // engine 可直接给 {@citation-js/core}（{Cite}）或省略走自动探测
      const core = opts.engine && opts.engine.Cite ? opts.engine : detectCSL();
      this.csl = core ? new CSLFormatter(core, opts.style, this.locale) : null;
    } else {
      this.csl = null;
    }
  }

  /** 是否使用 CSL 后端（style 指定且可用） */
  get enabled() { return !!this.csl; }

  /** 【文档建议接口】条目数据标准化：bib 条目对象 → 内部标准 */
  normalize(entries) {
    const out = {};
    if (!entries || typeof entries !== 'object') return out;
    for (const [k, v] of Object.entries(entries)) out[k] = normalizeEntry(v);
    return out;
  }

  /**
   * 内联引用文本（author-year 族 / CSL）：@cite("a","b") 的格式化部分。
   * numeric 由 Renderer 保留自己的上标逻辑，不调用本方法。
   * @param {string[]} keys
   * @param {{ bibliography: object }} context
   */
  formatCitation(keys, context = {}) {
    if (this.csl) {
      const entries = keys.map((k) => context.bibliography && context.bibliography[k])
        .filter((e) => e != null).map((e) => (typeof e === 'string' ? { title: e } : e));
      if (!entries.length) return '';
      return this.csl.formatInline(entries, { bare: true });
    }
    // 内置 author-year/author 文本（兼容模型，无 CSL 时）
    return keys.map((k) => {
      const e = normalizeEntry(context.bibliography && context.bibliography[k]);
      const authors = e.authors || String(k);
      return `${authors}${e.year !== undefined ? `, ${e.year}` : ''}`;
    }).join('; ');
  }

  /**
   * 参考文献条目格式化（单个 entry → HTML 文本；不含 <li>/包裹）。
   * @param {object} entry - 原始条目（任意模型）
   * @param {{ bibStyle?: string, escapeHtml?: boolean }} context
   */
  formatBibliography(entry, context = {}) {
    if (this.csl) return this.csl.formatEntry(typeof entry === 'string' ? { title: entry } : entry);
    return formatLightweight(entry, context.bibStyle || 'default', context.escapeHtml !== false);
  }
}

/** 内置 lightweight 条目格式化（0.2.1 兼容：default / gbt7714），支持 CSL-JSON 字段 */
export function formatLightweight(entry, bibStyle = 'default', escapeHtml = true) {
  const e = normalizeEntry(entry);
  const esc = (t) => (escapeHtml
    ? String(t).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    : String(t));
  const title = e.title ? esc(e.title) : '';
  const titleHtml = e.url
    ? `<a href="${esc(safeLinkUrl(e.url))}">${title}</a>` : title;
  if (bibStyle === 'gbt7714') {
    const parts = [];
    if (e.authors) parts.push(esc(e.authors));
    let t = titleHtml;
    if (t) parts.push(`${t}${t.endsWith('.') ? '' : '.'}`);
    if (e.container) parts.push(`${esc(e.container)},`);
    if (e.year !== undefined) parts.push(`${esc(String(e.year))}.`);
    return parts.join(' ');
  }
  const parts = [];
  if (e.authors) parts.push(esc(e.authors));
  if (e.year !== undefined) parts.push(`(${esc(String(e.year))})`);
  if (titleHtml) parts.push(titleHtml);
  if (e.container) parts.push(esc(e.container));
  return parts.join(' ');
}
