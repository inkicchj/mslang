/**
 * BlockEditor — 分块渲染封装（宿主块更新单一接口）
 *
 * 数据层封装（不碰 DOM）：管理源码/哈希/块区间状态，宿主只需：
 *   - render(): 初始切分，返回每块 html + 脚注区 + 哈希
 *   - update(i, newText): 编辑块 i，内部完成 拼源码 → 全量重渲 → diff →
 *     局部（renderBlock 逐块）/ 降级（块数变化或变化多 → 全量）决策
 * 内部复用 renderBlocks / renderBlock / diffBlocks / Parser，
 * 行为与 render({blocks:true}) 完全一致（含编号传播、渲染依赖、脚注区）。
 *
 * 用法：
 *   const ed = new BlockEditor(source, { data });
 *   const { blocks, footnotes } = ed.render();       // {i: html}
 *   const r = ed.update(3, '新文本');                 // {changed, blocks, full}
 *   ed.setOptions({ data: newData });                // 数据更新后重渲
 */

import { HTMLRenderer, diffBlocks } from './renderer.js';
import { Parser } from './parser.js';
import { expandIncludes } from './include.js';

/** 局部替换上限：变化块超过该数量时降级为全量重建 */
const FULL_REBUILD_THRESHOLD = 3;

/**
 * 将 renderBlocks 的哨兵 html 切分为逐块 html 与脚注区（剥离 mslang wrapper）。
 * @param {string} html
 * @returns {{ blocks: Object<number,string>, footnotes: string }}
 */
export function splitBlockHTML(html) {
  const blocks = {};
  const markers = [...html.matchAll(/<!--mslang:(\d+)-->/g)]
    .map(m => ({ i: Number(m[1]), start: m.index, end: m.index + m[0].length }));
  const fm = html.indexOf('<!--mslang:footnotes-->');
  const fmEnd = fm === -1 ? -1 : fm + '<!--mslang:footnotes-->'.length;
  for (let k = 0; k < markers.length; k++) {
    const start = markers[k].end;
    const end = k + 1 < markers.length ? markers[k + 1].start : (fm !== -1 ? fm : html.length);
    blocks[markers[k].i] = html.slice(start, end);
  }
  let footnotes = '';
  if (fm !== -1) {
    footnotes = html.slice(fmEnd).replace(/<\/div>\s*$/, ''); // 剥 wrapper 关闭标签
  }
  return { blocks, footnotes };
}

export class BlockEditor {
  /**
   * @param {string} source - mslang 全文
   * @param {object} [options] - 与 render() 相同（data/variables/headingNumbering/…）
   */
  constructor(source, options = {}) {
    this.options = { ...options };
    // 跨文档引用：构造时展开（同步 loader）；异步 loader 请用 render(src, {include, async:true})
    this.source = typeof source === 'string' && options.include
      ? expandIncludes(source, { include: options.include, issues: [] })
      : source;
    if (this.source instanceof Promise) {
      throw new Error('BlockEditor 仅支持同步 include loader（异步请用 render async:true）');
    }
    this.renderer = new HTMLRenderer({
      functions: options.functions,
      escapeHtml: options.escapeHtml,
      pretty: options.pretty,
    });
    this.parser = new Parser();
    this.hashes = null;
    this.blocks = [];          // 最近一次解析的块（含 startPos/endPos/raw）
    this._blockHtml = {};      // i -> 最近一次块 html
    this._footnotesHtml = '';
  }

  /** 初始渲染：切分每块 html + 脚注区 + 哈希。必须先调用，之后才可 update。 */
  render() {
    const { html, blockHashes } = this.renderer.renderBlocks(this.source, this.options);
    const { blocks, footnotes } = splitBlockHTML(html);
    this.hashes = blockHashes;
    this.blocks = this.parser.parseText(this.source).blocks;
    this._blockHtml = blocks;
    this._footnotesHtml = footnotes;
    return { blocks, footnotes, hashes: blockHashes };
  }

  /**
   * 编辑块 i：替换源码区间 → 全量重渲 → diff → 局部/全量决策。
   * @param {number} i - 块索引
   * @param {string} newText - 块新文本（原样保存，勿 trim）
   * @returns {{ changed: Array<number|string>, blocks: Object, footnotes?: string, full: boolean }}
   */
  update(i, newText) {
    const b = this.blocks[i];
    if (!b) throw new Error(`块 ${i} 不存在（共 ${this.blocks.length} 块）`);
    // 块 raw 含块间空行分隔（如 "段落\n\n"）：只替换内容部分，保留分隔防块合并
    const raw = b.raw || '';
    let contentEnd = b.endPos;
    if (raw.endsWith('\n')) contentEnd -= (raw.match(/\n+$/)[0] || '').length;
    const newSource = this.source.slice(0, b.startPos) + newText + this.source.slice(contentEnd);
    return this.updateSource(newSource);
  }

  /**
   * 以新源码重渲（逃生口：可改任意部分，含脚注定义行——它不属于任何块）。
   * 与 update() 相同的局部/全量决策。
   * @param {string} newSource
   * @returns {{ changed: Array<number|string>, blocks: Object, footnotes?: string, full: boolean }}
   */
  updateSource(newSource) {
    const { html, blockHashes } = this.renderer.renderBlocks(newSource, this.options);
    const changed = diffBlocks(this.hashes, blockHashes);
    const nextBlocks = this.parser.parseText(newSource).blocks;
    const full = nextBlocks.length !== this.blocks.length || changed.length > FULL_REBUILD_THRESHOLD;

    this.source = newSource;
    this.hashes = blockHashes;
    this.blocks = nextBlocks;

    if (full) {
      const split = splitBlockHTML(html);
      this._blockHtml = split.blocks;
      this._footnotesHtml = split.footnotes;
      return { changed, blocks: split.blocks, footnotes: split.footnotes, full: true };
    }

    const out = {};
    for (const j of changed) {
      if (j === 'footnotes') {
        const split = splitBlockHTML(html);
        this._footnotesHtml = split.footnotes;
        out.footnotes = split.footnotes;
      } else {
        const blockHtml = this.renderer.renderBlock(newSource, j, this.options);
        out[j] = blockHtml;
        this._blockHtml[j] = blockHtml;
      }
    }
    return { changed, blocks: out, full: false };
  }

  /** 更新渲染选项（如 data 变化后重渲）：merge 后需重新 render() */
  setOptions(overrides) {
    this.options = { ...this.options, ...overrides };
  }
}
