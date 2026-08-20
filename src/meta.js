/**
 * meta.js — 论文元数据提取（mslang 0.3）
 *
 * @meta({ title, authors, affiliations, abstract, keywords, language }) 文档头部：
 *   独占行 FunctionCall，参数限定为字面量对象（对象/数组/字符串/数字，无变量依赖）。
 *   提取结果挂到 document.meta，供 SemanticModel / analyze / AI 工作台消费，不参与渲染。
 */

import { FunctionCall, Paragraph } from './nodes.js';
import { evaluate } from './expression.js';

/** 扫描文档顶层 @meta 头部并求值合并（@meta 只接受字面量对象；求值失败忽略） */
export function extractMetaBlocks(document, evalCtx) {
  const meta = {};
  for (const b of document.blocks) {
    if (!(b instanceof Paragraph) || b.content.length !== 1) continue;
    const fc = b.content[0];
    if (!(fc instanceof FunctionCall) || fc.error || fc.name !== 'meta') continue;
    try {
      const m = evaluate(fc.args[0], evalCtx);
      if (m && typeof m === 'object' && !Array.isArray(m)) Object.assign(meta, m);
    } catch (e) {
      // @meta 求值失败忽略（头部本应为字面量；渲染期 meta 函数输出空）
    }
  }
  return meta;
}

/** 统一入口：Document/合并元数据（基）→ options.meta（宿主）→ 文档 @meta（覆盖）→ document.meta */
export function applyDocMeta(document, runtime, opts) {
  const base = document.meta && typeof document.meta === 'object' ? document.meta : {};
  document.meta = {
    ...base,
    ...(opts.meta || {}),
    ...extractMetaBlocks(document, runtime.evalCtx),
  };
}
