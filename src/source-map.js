/**
 * source-map.js — 源码映射（mslang 0.3：include 后仍能定位原文件）
 *
 * IncludeExpander 展开时逐行记录来源文件，合并为连续段：
 *   segments = [{ sourceId, start, end }]（相对最终合并文档的偏移）
 * 诊断 span 经 locate(start) 补 sourceId → "打开 chapter2.msl 修改第 832–850 字符"。
 * 无 include / 根文档行为 sourceId=null（不做标记，保持 0.2 兼容）。
 */

/** 文本收集器：逐行追加并记录来源（root 文档行 sourceId=null，include 行=目标路径） */
export class TextBuilder {
  constructor(rootSourceId = null) {
    this.rows = [];            // [{ text, sourceId }]（text 不含换行）
    this.rootSourceId = rootSourceId || null;
  }

  /** 追加一行（不含换行），来源默认当前层 */
  line(text, sourceId = this.rootSourceId) {
    this.rows.push({ text: String(text), sourceId });
  }

  /** 追加多行文本块（整体标记同一来源），如 include 展开/part 区间 */
  block(text, sourceId = this.rootSourceId) {
    const lines = String(text).split('\n');
    for (const l of lines) this.line(l, sourceId);
  }

  /** 拼接为最终文档文本（行间 \n） */
  get text() {
    return this.rows.map((r) => r.text).join('\n');
  }

  /** 行级来源 → 连续同源合并段 [{ sourceId, start, end }] */
  buildSegments() {
    const segs = [];
    let offset = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const start = offset;
      const end = start + r.text.length;
      const last = segs[segs.length - 1];
      if (last && last.sourceId === r.sourceId) {
        last.end = end;
      } else {
        segs.push({ sourceId: r.sourceId, start, end });
      }
      offset = end + 1; // +1 = 行间隔 '\n'
    }
    return segs;
  }
}

/** 源码映射：locate(offset) → 所属段（含 sourceId） */
export class SourceMap {
  /** @param {Array<{sourceId: (string|null), start: number, end: number}>} segments */
  constructor(segments = []) {
    this.segments = segments;
  }

  static fromBuilder(builder) {
    return new SourceMap(builder ? builder.buildSegments() : []);
  }

  /**
   * 定位偏移所属来源段。
   * @param {number} offset
   * @returns {{sourceId: (string|null), start: number, end: number}|null}
   */
  locate(offset) {
    const o = Number(offset);
    for (const s of this.segments) {
      if (o >= s.start && o <= s.end) return s;
    }
    return null;
  }

  /** 该偏移处来源是否为 include 文件（sourceId 非空） */
  isIncluded(offset) {
    const s = this.locate(offset);
    return !!(s && s.sourceId);
  }
}
