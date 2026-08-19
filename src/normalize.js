/**
 * normalize.js — 稳定化（mslang 0.2 拆分：Raw AST → Stable AST）
 *
 * 职责：把 Parser 产出的"表面语法"组合成语义上稳定的结构——
 * 定理环境（@theorem+段落）、@part/@end 区间、脚注编号。
 * Parser 只负责 Token → Raw AST（结构出现）；Normalizer 负责"组合语义"。
 * 依赖注入来自 parser.js 的 parseInlineFragment/walkNodes（ESM 延迟求值，避免环形顶层求值）。
 */

import {
  Paragraph, FunctionCall, LineBreak, RawText, Theorem, PartBlock, FootnoteRef,
} from './nodes.js';
import { parseInlineFragment, walkNodes } from './parser.js';

// 定理环境类型（@theorem/@lemma/@definition/@remark/@example 标记行）
const THEOREM_TYPES = ['theorem', 'lemma', 'definition', 'remark', 'example'];

/** 合并相邻的 RawText 节点（normalize 局部；parser 自身的 _mergeAdjacentText 保留） */
function mergeText(nodes) {
  if (!nodes.length) return nodes;
  const merged = [];
  for (const node of nodes) {
    if (merged.length && merged[merged.length - 1] instanceof RawText && node instanceof RawText) {
      merged[merged.length - 1] = new RawText(merged[merged.length - 1].text + node.text);
    } else {
      merged.push(node);
    }
  }
  return merged;
}

/**
 * 定理环境归并：纯 FunctionCall(@theorem/@lemma/…) 段落 + 下一段落 → Theorem 块。
 * 内容限单段落；不匹配（无下一段/非段落）时降级为普通段落（保留原文本）。
 * @param {Document} doc
 */
export function normalizeTheorems(doc) {
  const blocks = doc.blocks;
  for (let i = 0; i < blocks.length - 1; i++) {
    const b = blocks[i];
    if (!(b instanceof Paragraph)) continue;
    const fc = b.content.length === 1 ? b.content[0] : null;
    if (!(fc instanceof FunctionCall) || !THEOREM_TYPES.includes(fc.name)) continue;
    const label = fc.args[0] && fc.args[0].type === 'string' ? fc.args[0].value : '';
    const title = fc.args[1] && fc.args[1].type === 'string'
      ? parseInlineFragment(fc.args[1].value) : [];
    const next = blocks[i + 1];
    if (!(next instanceof Paragraph)) continue;
    blocks[i] = new Theorem(fc.name, label, title, next.content);
    blocks.splice(i + 1, 1);
  }
}

/**
 * @part 区间归并：@part("id", "标题") 标记行（纯 FunctionCall 段落）+ 到匹配 @end 的
 * 多块区间 → PartBlock（嵌套 @part 递归归并）。@end 缺失/孤立时降级为普通段落（保留原文）。
 * @param {Document} doc
 */
export function normalizeParts(doc) {
  const blocks = doc.blocks;
  // @part 标记行 = 独立段落的纯 FunctionCall（段尾可有 LineBreak 节点）
  const partMarker = (b) => {
    if (!(b instanceof Paragraph)) return null;
    const c = b.content;
    const fc = c.length === 1 && c[0] instanceof FunctionCall
      ? c[0]
      : c.length === 2 && c[0] instanceof FunctionCall && c[1] instanceof LineBreak ? c[0] : null;
    return fc && !fc.error && fc.name === 'part' ? fc : null;
  };
  // @end 行 = 段末行首的标记（RawText('@end') 无括号写法，或 FunctionCall('end')）
  const endMarker = (b) => {
    if (!(b instanceof Paragraph)) return null;
    const c = b.content;
    if (c.length === 1 && c[0] instanceof RawText && c[0].text.trim() === '@end') return c[0];
    const last = c[c.length - 1];
    if (last instanceof RawText && last.text.trim() === '@end'
      && (c.length === 1 || c[c.length - 2] instanceof LineBreak)) return last;
    if (last instanceof FunctionCall && !last.error && last.name === 'end'
      && c.length >= 2 && c[c.length - 2] instanceof LineBreak) return last;
    return null;
  };
  const strArg = (fc, i) => fc.args[i] && fc.args[i].type === 'string' ? fc.args[i].value : '';
  /** 递归收集：返回 { blocks, next }；next 指向本层 @end 之后 */
  const collect = (start, top) => {
    const out = [];
    let i = start;
    while (i < blocks.length) {
      const b = blocks[i];
      const eMark = endMarker(b);
      if (eMark) {
        if (top) { out.push(b); i++; continue; } // 孤立 @end（无 part）：保留为普通段落
        // 紧贴写法 "正文\n@end"：@end 前的内容保留，仅剥 @end 行
        if (b instanceof Paragraph) {
          const c = b.content;
          const idx = c.findIndex((n) => (n instanceof FunctionCall && n.name === 'end')
            || (n instanceof RawText && n.text.trim() === '@end'));
          const keep = idx > 0 ? c.slice(0, idx - (c[idx - 1] instanceof LineBreak ? 1 : 0)) : [];
          if (keep.length) out.push(new Paragraph(mergeText(keep)));
        }
        return { blocks: out, next: i + 1 };
      }
      const fc = partMarker(b);
      if (fc) {
        const inner = collect(i + 1, false);
        out.push(new PartBlock(strArg(fc, 0), parseInlineFragment(strArg(fc, 1)), inner.blocks));
        i = inner.next;
      } else {
        out.push(b);
        i++;
      }
    }
    return { blocks: out, next: i };
  };
  doc.blocks = collect(0, true).blocks;
}

/** 脚注编号：引用按出现顺序编号（walkNodes 递归 content/children/blocks/items） */
export function normalizeFootnotes(doc) {
  let counter = 0;
  walkNodes(doc, (node) => {
    if (node instanceof FootnoteRef) {
      counter++;
      node.number = counter;
    }
  });
}

/**
 * Parser 主循环之后的结构归并（定理 + @part 区间）。
 * 在块源区间计算前调用（归并块保留原 startPos 覆盖区间）。
 */
export function normalizeDocument(doc) {
  normalizeTheorems(doc);
  normalizeParts(doc);
}