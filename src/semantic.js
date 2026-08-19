/**
 * semantic.js — 语义分析层（mslang 0.2 拆分：不产生 HTML，不依赖 Renderer）
 *
 * 职责：引用（图/表/式/标题/定理/part 标签）、引文编号、术语收集、编号序列、
 * 块渲染依赖、诊断。Renderer + Builtin 经 SemanticModel 查询（本文件不反向依赖 Renderer）。
 * 配置（headingNumbering/refNumbering/citeStyle/data/...）来自 RuntimeContext。
 */

import { extractHeadingNumber } from './builtin.js';
import {
  FunctionCall, RawText, Image, PartBlock, Heading,
  Table, Equation, CodeBlock, Theorem, FootnoteRef,
} from './nodes.js';

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
// SemanticModel
// ================================================================

export class SemanticModel {
  constructor() {
    this.refs = {};              // label -> { kind, number|display, type? }
    this.citeNumbers = {};       // cite 键 -> 顺序号
    this.citeOrder = [];         // cite 键出现顺序
    this.citeYearSuffix = {};    // author-year 消歧后缀（a/b/c...）
    this.termOrder = [];         // 术语键出现顺序
    this.headingSeq = [];        // 标题自动编号序列（渲染按序消费）
    this.diagnostics = [];       // Phase 5：诊断（code/severity/span/data）
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

    // 单一遍历：块 → 块内行内；PartBlock 递归进内部块（内部标题/图/表/式/定理照常收集）
    const collectBlock = (block) => {
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
        block.blocks.forEach(collectBlock);
        return;
      }
      if (block instanceof Heading) {
        const autoNum = runtime.headingNumbering ? nextSecNumber(block.level) : '';
        sm.headingSeq.push(autoNum);
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
      }
      if (block instanceof Equation && block.label) {
        counters.eq++;
        sm.refs[block.label] = { kind: 'eq', number: counters.eq };
      }
      if (block instanceof CodeBlock && block.label && block.language === 'mermaid') {
        // mermaid 流程图与图片共享 fig 编号序列
        counters.fig++;
        sm.refs[block.label] = { kind: 'fig', number: counters.fig };
      }
      if (block instanceof Theorem && block.label) {
        // 定理/引理/定义共享编号序列，type 用于显示前缀
        counters.thm++;
        sm.refs[block.label] = { kind: 'thm', type: block.type, number: counters.thm };
      }
      if (block.content || block.items) eachBlockInline(block, walkInlineList);
    };
    doc.blocks.forEach(collectBlock);
    currentDeps = null;

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