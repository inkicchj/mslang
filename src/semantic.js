/**
 * semantic.js — 语义分析层（mslang 0.2 拆分：不产生 HTML，不依赖 Renderer）
 *
 * 职责：引用（图/表/式/标题/定理/part 标签）、引文编号、术语收集、编号序列、
 * 块渲染依赖、诊断。Renderer + Builtin 经 SemanticModel 查询（本文件不反向依赖 Renderer）。
 * 配置（headingNumbering/refNumbering/citeStyle/data/...）来自 RuntimeContext。
 */

import { extractHeadingNumber } from './numbering.js';
import {
  FunctionCall, RawText, Image, PartBlock, Heading,
  Table, Equation, CodeBlock, Theorem, FootnoteRef,
} from './nodes.js';
import { walkNodes } from './ast-utils.js';

// ================================================================
// 遍历辅助（Renderer 的 _applySets / _checkIntegrity 与 分析器共用）
// ================================================================

/** 遍历单个块的全部行内节点（content/items/children，递归穿过行内容器） */
export function eachBlockInline(block, fn) {
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
export function eachBlocksInline(blocks, fn) {
  for (const b of blocks) {
    if (b instanceof PartBlock) { eachBlocksInline(b.blocks, fn); continue; }
    eachBlockInline(b, fn);
  }
}

/** 遍历表达式树（call/var/unary/binary/object/array），call 回调 onCall、变量回调 onVar */
export function walkExprTree(node, onCall, onVar) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'call') {
    if (onCall) onCall(node);
    node.args.forEach(a => walkExprTree(a, onCall, onVar));
    Object.values(node.kwargs).forEach(a => walkExprTree(a, onCall, onVar));
  } else if (node.type === 'var') {
    if (onVar) onVar(node);
  } else if (node.type === 'unary') {
    walkExprTree(node.operand, onCall, onVar);
  } else if (node.type === 'binary') {
    walkExprTree(node.left, onCall, onVar);
    walkExprTree(node.right, onCall, onVar);
  } else if (node.type === 'object') {
    Object.values(node.value).forEach(a => walkExprTree(a, onCall, onVar));
  } else if (node.type === 'array') {
    node.items.forEach(a => walkExprTree(a, onCall, onVar));
  }
}

// ================================================================
// 诊断（opts.check 时）
// ================================================================

// 诊断 code → 公共 issues type 映射（公共 API 保持 type 命名兼容）
export const DIAG_ISSUE_TYPE = {
  'missing-citation': 'missing_cite',
  'missing-term': 'missing_term',
  'missing-reference': 'missing_ref',
  'missing-footnote': 'missing_footnote',
  'duplicate-label': 'duplicate_label',
  'orphan-caption': 'orphan_caption',
  'missing-include': 'missing_include',
  'missing-part': 'missing_part',
};

const DIAG_MESSAGES = {
  'missing-citation': '引用了不存在的文献',
  'missing-term': '引用了不存在的术语',
  'missing-reference': '引用了不存在的交叉引用标签',
  'missing-footnote': '引用了未定义的脚注',
  'duplicate-label': '重复声明了标签',
  'orphan-caption': '孤立 caption（未归并到目标块）',
  'missing-include': 'include 加载失败（文档缺失）',
  'missing-part': '引用了不存在的 part（@part 区间）',
};

/**
 * 引用完整性诊断（opts.check 时）：缺失文献/术语/交叉引用/脚注、
 * 重复标签、孤立 caption。按 code+label 去重计数，附首次出现块索引与源码区间。
 * sourceMap（可选，0.3 include 溯源）命中 include 段时 span 附加 sourceId。
 * @param {Document} doc
 * @param {import('./runtime.js').RuntimeContext} runtime
 * @param {SemanticModel} sm - analyze() 产出（前向引用已完整）
 * @param {object} [sourceMap] - prepare 产物（include 展开的来源映射）
 * @returns {Array<{code: string, severity: string, message: string, span: {start: number, end: number, sourceId?: string}, data: {label: string}, block: number, count: number}>}
 */
export function checkIntegrity(doc, runtime, sm, sourceMap = null) {
  const diagnostics = [];
  const seen = new Map();
  const seenLabels = new Set();
  let currentBlock = -1;
  const blockAt = (i) => doc.blocks[i];
  // include 溯源：span 命中 include 段时附加 sourceId（"打开 chapter2.msl 修改 832–850"）
  const locate = (base) => {
    if (!sourceMap || !base) return base;
    const s = sourceMap.locate(base.start);
    return s && s.sourceId ? { ...base, sourceId: s.sourceId } : base;
  };
  const report = (code, label, span) => {
    const id = `${code}|${label}`;
    if (seen.has(id)) { diagnostics[seen.get(id)].count++; return; }
    seen.set(id, diagnostics.length);
    const b = blockAt(currentBlock);
    diagnostics.push({
      code, severity: 'warning',
      message: `${DIAG_MESSAGES[code] || code}「${label}」`,
      // 节点级 span（@cite/@ref/@term/[^n] 精确位置），缺失时回退块区间
      span: span && span.start < span.end
        ? locate({ start: span.start, end: span.end })
        : (b ? locate({ start: b.startPos != null ? b.startPos : 0, end: b.endPos != null ? b.endPos : 0 }) : undefined),
      data: { label }, block: currentBlock, count: 1,
    });
  };
  const handleCall = (call) => {
    if (call.name === 'cite') {
      for (const a of call.args) {
        if (a.type === 'string' && !(runtime.data.bibliography && runtime.data.bibliography[a.value])) {
          report('missing-citation', a.value, call.span);
        }
      }
    } else if (call.name === 'term') {
      const a = call.args[0];
      if (a && a.type === 'string' && !(runtime.data.terms && runtime.data.terms[a.value])) {
        report('missing-term', a.value, call.span);
      }
    } else if (call.name === 'ref') {
      const a = call.args[0];
      if (a && a.type === 'string' && !sm.refs[a.value]) report('missing-reference', a.value, call.span);
    }
  };
  const markLabel = (label) => {
    if (!label) return;
    if (seenLabels.has(label)) report('duplicate-label', label);
    else seenLabels.add(label);
  };
  const walkInlineList = (n) => {
    // 顶层 FunctionCall（AST 节点，无 type 字段）；嵌套表达式由 walkExprTree 处理
    if (n instanceof FunctionCall) {
      handleCall(n);
      n.args.forEach(a => walkExprTree(a, handleCall));
    }
    if (n instanceof FootnoteRef && !(n.label in doc.footnotes)) report('missing-footnote', n.label, n.span);
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
    if (block._orphanCaption) report('orphan-caption', block._orphanCaption);
    if (block.content || block.items) eachBlockInline(block, walkInlineList);
  };
  doc.blocks.forEach((block, i) => walkBlock(block, i));
  currentBlock = -1;
  return diagnostics;
}

/**
 * 学术一致性诊断（0.3 确定性检查；原则：语言核心只做确定性检查，主观学术评价交 AI 工作台）。
 *   - unreferenced-figure / unreferenced-table / unused-label（式/定理）：label 未被 @ref 引用
 *   - unused-bibliography：bibliography 条目从未被 @cite 引用
 *   - missing-title / missing-abstract / missing-keywords：仅当文档已声明 meta（@meta/options.meta）
 * 全部由 AST/数据推导，无 AI 判断；severity 定为 info（一致性提示，非语法错误）。
 * @param {Document} doc
 * @param {import('./runtime.js').RuntimeContext} runtime
 * @param {SemanticModel} sm
 * @param {object} [sourceMap]
 */
export function checkAcademic(doc, runtime, sm, sourceMap = null) {
  const diagnostics = [];
  const locate = (base) => {
    if (!sourceMap || !base) return base;
    const s = sourceMap.locate(base.start);
    return s && s.sourceId ? { ...base, sourceId: s.sourceId } : base;
  };
  const push = (code, label, message, span) => {
    diagnostics.push({
      code, severity: 'info', message,
      span: span && span.start < span.end ? locate({ start: span.start, end: span.end }) : undefined,
      data: { label }, block: -1, count: 1,
    });
  };
  // 已被 @ref 引用的 label 集合
  const refed = new Set();
  eachBlocksInline(doc.blocks, (n) => {
    if (n instanceof FunctionCall && n.name === 'ref' && n.args[0] && n.args[0].type === 'string') {
      refed.add(n.args[0].value);
    }
  });
  for (const f of sm.figures || []) if (!refed.has(f.label)) push('unreferenced-figure', f.label, `图「${f.label}」未被正文引用`);
  for (const t of sm.tables || []) if (!refed.has(t.label)) push('unreferenced-table', t.label, `表「${t.label}」未被正文引用`);
  for (const e of sm.equations || []) if (!refed.has(e.label)) push('unused-label', e.label, `公式「${e.label}」未被引用`);
  for (const th of sm.theorems || []) if (!refed.has(th.label)) push('unused-label', th.label, `定理「${th.label}」未被引用`);
  // 未使用文献条目
  const bib = runtime.data && runtime.data.bibliography;
  if (bib && typeof bib === 'object') {
    const cited = new Set(sm.citeOrder || []);
    for (const key of Object.keys(bib)) {
      if (!cited.has(key)) push('unused-bibliography', key, `文献「${key}」未在正文中被引用`);
    }
  }
  // 元数据完整性：仅当文档已声明论文元数据时才检查缺失项（避免常规文档刷 missing-*）
  const meta = doc.meta;
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    if (!meta.title) push('missing-title', 'title', '缺少论文标题（meta.title）');
    if (!meta.abstract) push('missing-abstract', 'abstract', '缺少摘要（meta.abstract）');
    if (!Array.isArray(meta.keywords) || meta.keywords.length === 0) {
      push('missing-keywords', 'keywords', '缺少关键词（meta.keywords）');
    }
  }
  return diagnostics;
}

export class SemanticModel {
  constructor() {
    this.refs = {};              // label -> { kind, number|display, type? }
    this.citeNumbers = {};       // cite 键 -> 顺序号
    this.citeOrder = [];         // cite 键出现顺序
    this.citeYearSuffix = {};    // author-year 消歧后缀（a/b/c...）
    this.termOrder = [];         // 术语键出现顺序
    this.headingSeq = [];        // 标题自动编号序列（渲染按序消费）
    this.diagnostics = [];       // Phase 5：诊断（code/severity/span/data）
    // —— 0.3 论文分析模型（从已有 AST 推导，无新增语法）——
    this.outline = [];           // [{id, text, number, level, block}] 标题大纲
    this.sections = [];          // [{id, text, number, level, startBlock, endBlock, cites, figures, tables, equations, theorems}]
    this.figures = [];           // [{label, number}]
    this.tables = [];            // [{label, number}]
    this.equations = [];         // [{label, number}]
    this.theorems = [];          // [{label, number, type}]
    this.footnotes = [];         // [{label, number, text}]（含未引用定义）
    this.references = [];        // [{key, number, entry}]（被引用的文献明细）
    this.stats = {};             // {words, citations, figures, tables, equations, theorems, sections, footnotes}
  }

  /** 文献键编号：首次出现分配顺序号（预收集 + 运行时动态 cite 共用） */
  registerCite(key) {
    if (!(key in this.citeNumbers)) {
      this.citeNumbers[key] = this.citeOrder.length + 1;
      this.citeOrder.push(key);
    }
  }

  /** 术语键收集：首次出现加入 termOrder */
  registerTerm(name) {
    if (!this.termOrder.includes(name)) this.termOrder.push(name);
  }
}

// ================================================================
// SemanticAnalyzer
// ================================================================

export class SemanticAnalyzer {
  /**
   * @param {{ runtime: import('./runtime.js').RuntimeContext }} deps
   */
  constructor({ runtime } = {}) {
    this.runtime = runtime;
  }

  /**
   * 收集引用编号与依赖（渲染前整篇遍历，顺序与渲染一致）：
   *   - cite("key") 按出现顺序编号；图/表/标题/定理 label → refs
   *   - 块渲染依赖（变量/宏/data）与编号前缀快照写回 block._deps/_prefixCounts
   *     （供块级编辑哈希定位变化块）
   * @param {Document} doc
   * @returns {SemanticModel}
   */
  analyze(doc) {
    const runtime = this.runtime;
    const sm = new SemanticModel();
    const counters = { fig: 0, tbl: 0, sec: 0, eq: 0, thm: 0 };
    let currentDeps = null;

    // 标题自动编号：按文档顺序对全部 Heading 计算层级编号（如 1 / 1.1 / 1.1.1）
    const sep = (runtime.headingNumbering.match(/[^\d1]/) || ['.'])[0];
    const levelCounts = [0, 0, 0, 0, 0, 0];
    const nextSecNumber = (level) => {
      levelCounts[level - 1]++;
      for (let i = level; i < 6; i++) levelCounts[i] = 0;
      const parts = [];
      for (let i = 0; i < level; i++) parts.push(levelCounts[i]);
      return parts.join(sep);
    };

    // 表达式树中的 cite/term/use（嵌套于 if 等函数参数；顶层 FunctionCall 由 walkInlineList 处理）
    const handleCall = (call) => {
      if (call.name === 'cite') {
        for (const a of call.args) {
          if (a.type !== 'string') continue;
          sm.registerCite(a.value);
          const entry = runtime.data.bibliography && runtime.data.bibliography[a.value];
          if (entry !== undefined) (currentDeps.d.cite ||= {})[a.value] = entry;
        }
      }
      if (call.name === 'term' && call.args[0] && call.args[0].type === 'string') {
        sm.registerTerm(call.args[0].value);
        const entry = runtime.data.terms && runtime.data.terms[call.args[0].value];
        if (entry !== undefined) (currentDeps.d.term ||= {})[call.args[0].value] = entry;
      }
      if (call.name === 'use' && call.args[0] && call.args[0].type === 'string') {
        const t = runtime.macros[call.args[0].value];
        if (t !== undefined) currentDeps.m[call.args[0].value] = t;
      }
      // 文献表/术语表块依赖对应数据全量（条目内容变化 → 表输出变）
      if (call.name === 'bibliography') currentDeps['bib-all'] = runtime.data.bibliography;
      if (call.name === 'glossary') currentDeps['term-all'] = runtime.data.terms;
    };

    // 行内节点处理（递归由 eachBlockInline 负责）
    const walkInlineList = (n) => {
      if (n instanceof Image && n.label) {
        counters.fig++;
        sm.refs[n.label] = { kind: 'fig', number: counters.fig };
        sm.figures.push({ label: n.label, number: counters.fig });
      }
      if (n instanceof FunctionCall) {
        handleCall(n);
        n.args.forEach(a => walkExprTree(a, handleCall, (v) => {
          if (v.name in runtime.variables) currentDeps.v[v.name] = runtime.variables[v.name];
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

    // 0.3 论文分析模型：标题大纲 / 图/表/式/定理清单
    const headingList = [];

    // 单一遍历：块 → 块内行内；PartBlock 递归进内部块（内部标题/图/表/式/定理照常收集）
    const collectBlock = (block, blockIndex) => {
      // 渲染依赖收集容器（块级编辑哈希：变量/宏/data 变化 → 引用块哈希变）
      const deps = { v: {}, m: {}, d: {} };
      block._deps = deps;
      currentDeps = deps;
      // 块渲染时的编号前缀快照（块级编辑哈希：块 i 之后编号变化 → 后续块哈希变）
      block._prefixCounts = {
        fig: counters.fig, tbl: counters.tbl, sec: counters.sec, eq: counters.eq, thm: counters.thm,
        cite: sm.citeOrder.length, term: sm.termOrder.length,
      };
      if (block instanceof PartBlock) {
        if (block.id) {
          const text = headingText(block.title) || block.id;
          // part 引用显示标题全文（可被 refNumbering 提取数字前缀，与标题同规则）
          let display;
          if (runtime.refNumbering) display = extractHeadingNumber(text, runtime.refNumbering);
          if (display === undefined) display = text;
          sm.refs[block.id] = { kind: 'part', display };
        }
        block.blocks.forEach((b) => collectBlock(b, blockIndex));
        return;
      }
      if (block instanceof Heading) {
        const autoNum = runtime.headingNumbering ? nextSecNumber(block.level) : '';
        sm.headingSeq.push(autoNum);
        headingList.push({
          level: block.level, id: block.id || '',
          text: headingText(block.content), number: autoNum, block: blockIndex,
        });
        if (block.id) {
          counters.sec++;
          const text = headingText(block.content);
          // 统一优先级：显式提取编号 > 自动编号 > 标题全文
          let display;
          if (runtime.refNumbering) {
            display = extractHeadingNumber(text, runtime.refNumbering);
          }
          if (display === undefined && autoNum) display = autoNum;
          if (display === undefined) display = text || `第 ${counters.sec} 节`;
          sm.refs[block.id] = { kind: 'sec', display };
        }
      }
      if (block instanceof Table && block.label) {
        counters.tbl++;
        sm.refs[block.label] = { kind: 'tbl', number: counters.tbl };
        sm.tables.push({ label: block.label, number: counters.tbl });
      }
      if (block instanceof Equation && block.label) {
        counters.eq++;
        sm.refs[block.label] = { kind: 'eq', number: counters.eq };
        sm.equations.push({ label: block.label, number: counters.eq });
      }
      if (block instanceof CodeBlock && block.label && block.language === 'mermaid') {
        // mermaid 流程图与图片共享 fig 编号序列
        counters.fig++;
        sm.refs[block.label] = { kind: 'fig', number: counters.fig };
        sm.figures.push({ label: block.label, number: counters.fig });
      }
      if (block instanceof Theorem && block.label) {
        // 定理/引理/定义共享编号序列，type 用于显示前缀
        counters.thm++;
        sm.refs[block.label] = { kind: 'thm', type: block.type, number: counters.thm };
        sm.theorems.push({ label: block.label, number: counters.thm, type: block.type });
      }
      if (block.content || block.items) eachBlockInline(block, walkInlineList);
    };
    doc.blocks.forEach((b, i) => collectBlock(b, i));
    currentDeps = null;

    // —— 0.3：outline / sections / references / footnotes / stats ——
    sm.outline = headingList;
    sm.footnotes = Array.isArray(doc.footnoteEntries)
      ? doc.footnoteEntries.map((e) => ({ ...e })) : [];
    sm.references = sm.citeOrder.map((key, i) => ({
      key, number: i + 1, entry: runtime.data.bibliography && runtime.data.bibliography[key],
    }));

    // sections：标题块区间 → 聚合该节引用的文献/图/表/式/定理（回答"哪节没引用/哪些图未引用"）
    const sections = headingList.map((h, idx) => {
      const end = idx + 1 < headingList.length ? headingList[idx + 1].block : doc.blocks.length;
      const cites = new Set();
      const figures = new Set();
      const tables = new Set();
      const equations = new Set();
      const theorems = new Set();
      for (let bi = h.block; bi < end; bi++) {
        const b = doc.blocks[bi];
        eachBlocksInline([b], (n) => {
          if (n instanceof FunctionCall && n.name === 'cite') {
            for (const a of n.args) if (a.type === 'string') cites.add(a.value);
          }
          if (n instanceof Image && n.label) figures.add(n.label);
          if (n instanceof CodeBlock && n.label && n.language === 'mermaid') figures.add(n.label);
        });
        if (b instanceof Table && b.label) tables.add(b.label);
        if (b instanceof Equation && b.label) equations.add(b.label);
        if (b instanceof Theorem && b.label) theorems.add(b.label);
      }
      return {
        id: h.id, text: h.text, number: h.number, level: h.level,
        startBlock: h.block, endBlock: end,
        cites: [...cites], figures: [...figures], tables: [...tables],
        equations: [...equations], theorems: [...theorems],
      };
    });
    sm.sections = sections;

    // stats：确定性统计（总字数来自全文 RawText）
    let words = 0;
    walkNodes(doc, (n) => {
      if (n instanceof RawText && n.text) {
        words += (n.text.match(/[A-Za-z0-9\u4e00-\u9fff]+/g) || []).length;
      }
    });
    sm.stats = {
      words, citations: sm.citeOrder.length,
      figures: sm.figures.length, tables: sm.tables.length,
      equations: sm.equations.length, theorems: sm.theorems.length,
      sections: sections.length, footnotes: sm.footnotes.length,
    };

    // author-year 样式消歧：同年同作者按引用顺序加 a/b/c 后缀（收集完成后计算，cite/bibliography 共用）
    if (runtime.citeStyle !== 'numeric') {
      const counts = {};
      for (const key of sm.citeOrder) {
        const entry = runtime.data.bibliography && runtime.data.bibliography[key];
        if (!entry || typeof entry !== 'object' || !entry.authors || entry.year === undefined) continue;
        const g = `${String(entry.authors).toLowerCase()}|${entry.year}`;
        counts[g] = (counts[g] || 0) + 1;
      }
      const seen = {};
      for (const key of sm.citeOrder) {
        const entry = runtime.data.bibliography && runtime.data.bibliography[key];
        if (!entry || typeof entry !== 'object' || !entry.authors || entry.year === undefined) continue;
        const g = `${String(entry.authors).toLowerCase()}|${entry.year}`;
        const idx = (seen[g] = (seen[g] || 0) + 1);
        sm.citeYearSuffix[key] = counts[g] > 1 ? String.fromCharCode(96 + idx) : '';
      }
    }
    return sm;
  }
}