/**
 * renderer-latex.js — 实验性 LaTeX 渲染器（mslang 0.3，第七阶段最小版）
 *
 * 用途：验证 AST 是否真正独立于 HTML。论文语义（section/equation/theorem/cite/
 * figure/table/bibliography/footnote）与 LaTeX 天然对应；若本渲染器难以实现，
 * 说明 AST 混入了过多 HTML 假设。
 *
 * 覆盖（最小可用，标注 experimental）：标题/段落/列表/引用/代码块/公式/图/表/
 * 定理/cite/ref/脚注/术语；未覆盖节点输出 % mslang 忽略 注释。不追求与 HTML 逐字对齐。
 * 复用 prepare() 管线（含 include 展开/SourceMap/Semantic），只消费 PreparedDocument。
 */

import {
  Bold, Italic, Strikethrough, InlineCode, Link, Image, LineBreak,
  Superscript, Subscript, FunctionCall, RawText, RawHtml,
} from './nodes.js';
import { normalizeEntry } from './citation.js';

/** LaTeX 保留字符转义（正文；公式/verbatim 不转义） */
function escLatex(text) {
  return String(text)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}%$#_&])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\n/g, ' ');
}

/** 行内纯文本提取（标题/表格单元格等用） */
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n instanceof RawText) out += n.text;
    else if (n.content) out += plainText(n.content);
  }
  return out;
}

export class LatexRenderer {
  constructor() {
    this._out = [];
  }

  /** @param {{document: object, semantic: object, runtime: object}} prepared */
  render(prepared) {
    this.semantic = prepared.semantic;
    this.runtime = prepared.runtime;
    this._currentDoc = prepared.document;
    this._out = [];
    (prepared.document.blocks || []).forEach((b) => this.visitBlock(b));
    return this._out.join(''); // 元素内已含显式换行，join 不再插入
  }

  _write(s) { this._out.push(s); }
  _p() { if (this._lastLine() !== '') this._write('\n'); }
  _lastLine() { return this._out[this._out.length - 1] || ''; }

  // ============ 块级 ============
  visitBlock(block) {
    switch (block.constructor.name) {
      case 'Heading': return this.blockHeading(block);
      case 'Paragraph': return this.blockParagraph(block);
      case 'BlockQuote': return this.blockQuote(block);
      case 'CodeBlock': return this.blockCode(block);
      case 'UnorderedList': return this.blockList(block, 'itemize');
      case 'OrderedList': return this.blockList(block, 'enumerate');
      case 'Table': return this.blockTable(block);
      case 'Equation': return this.blockEquation(block);
      case 'Theorem': return this.blockTheorem(block);
      case 'PartBlock': return this.blockPart(block);
      case 'HorizontalRule': return this._note('---');
      case 'AlignBlock': return this.blockAlign(block);
      case 'AlignLeft':
      case 'AlignRight': return this.blockAlign(block);
      default: return this._note(`已忽略块 ${block.constructor.name}`);
    }
  }

  blockHeading(b) {
    const levels = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
    const tag = levels[Math.min(b.level - 1, levels.length - 1)] || 'subparagraph';
    const text = escLatex(plainText(b.content));
    const label = b.id ? `\n\\label{${b.id}}` : '';
    this._p();
    this._write(`\\${tag}{${text}}${label}`);
  }

  blockParagraph(b) {
    this._p();
    this._write(this.inline(b.content));
    this._p();
  }

  blockQuote(b) {
    this._p();
    this._write('\\begin{quote}');
    this._p();
    this._write(this.inline(b.content));
    this._p();
    this._write('\\end{quote}');
  }

  blockCode(b) {
    if (b.language === 'mermaid') return this._note('mermaid 流程图（HTML 渲染器）');
    this._p();
    this._write('\\begin{verbatim}');
    this._p();
    this._write(b.code.replace(/\n$/, ''));
    this._p();
    this._write('\\end{verbatim}');
  }

  blockList(b, env) {
    this._p();
    this._write(`\\begin{${env}}`);
    for (const item of b.items) {
      this._write('\n\\item ');
      this._write(this.inline(item.content));
      if (item.children && item.children.length) {
        // 嵌套列表：把子块（列表等）并入
        const nested = item.children.filter((c) => ['UnorderedList', 'OrderedList'].includes(c.constructor.name));
        for (const sub of nested) this.blockList(sub, sub.constructor.name === 'OrderedList' ? 'enumerate' : 'itemize');
      }
    }
    this._write('\n\\end{' + env + '}');
  }

  blockTable(b) {
    this._p();
    const cols = Math.max((b.headers || [{}]).length, 1);
    this._write('\\begin{table}[h]\n\\centering\n\\begin{tabular}{' + 'l'.repeat(cols) + '}');
    if (b.headers && b.headers.length) {
      const cells = b.headers.map((c) => escLatex(plainText(Array.isArray(c) ? c : [c])));
      this._write(cells.join(' & ') + ' \\\\ \\hline');
    }
    for (const row of b.rows || []) {
      const cells = row.map((c) => escLatex(plainText(Array.isArray(c) ? c : [c])));
      this._write(`\n${cells.join(' & ')} \\\\`);
    }
    this._write('\n\\end{tabular}');
    if (b.caption && b.caption.length) this._write(`\n\\caption{${escLatex(plainText(b.caption))}}`);
    if (b.label) this._write(`\n\\label{${b.label}}`);
    this._write('\n\\end{table}');
  }

  blockEquation(b) {
    this._p();
    this._write(b.inline ? `$${b.source}$` : `\\[${b.source}\\]`);
    if (!b.inline && b.label) this._write(`\\label{${b.label}}`);
  }

  blockTheorem(b) {
    const env = ['lemma', 'definition', 'remark', 'example'].includes(b.type) ? b.type : 'theorem';
    this._p();
    this._write(`\\begin{${env}}`);
    if (b.title && b.title.length) this._write(`[${escLatex(plainText(b.title))}]`);
    this._write('\n');
    this._write(this.inline(b.content));
    if (b.label) this._write(`\n\\label{${b.label}}`);
    this._write(`\n\\end{${env}}`);
  }

  blockPart(b) {
    if (b.id) this._write(`\n% part ${b.id}`);
    (b.blocks || []).forEach((c) => this.visitBlock(c));
  }

  blockAlign(b) {
    this._p();
    this._write('\\begin{center}');
    this._p();
    this._write(this.inline(b.content));
    this._p();
    this._write('\\end{center}');
  }

  /** 未支持节点输出注释（可读、不破坏编译） */
  _note(msg) {
    this._p();
    this._write(`% mslang: 未覆盖 ${msg}`);
  }

  // ============ 行内 ============
  inline(nodes) {
    return (nodes || []).map((n) => this.inlineNode(n)).join('');
  }

  inlineNode(n) {
    switch (n.constructor.name) {
      case 'RawText': return n.text;
      case 'Bold': return this._inlineEnv('textbf', n.content);
      case 'Italic': return this._inlineEnv('textit', n.content);
      case 'Strikethrough': return this._inlineEnv('sout', n.content);
      case 'InlineCode': return `\\texttt{${escLatex(n.code)}}`;
      case 'LineBreak': return ' \\newline{} ';
      case 'Link': return `\\url{${escLatex(n.url)}}`;
      case 'Superscript': return `\\textsuperscript{${this.inline(n.content)}}`;
      case 'Subscript': return `\\textsubscript{${this.inline(n.content)}}`;
      case 'Image': return this._note(`图片 ${n.alt}（请用独立段落放置）`);
      case 'FootnoteRef': return `\\footnote{${escLatex(this.footnoteText(n.label))}}`;
      case 'FunctionCall': return this.call(n);
      case 'Color': return escLatex(n.text);
      case 'RawHtml': return '';
      default: return '';
    }
  }

  _inlineEnv(env, content) {
    return `\\${env}{${this.inline(content)}}`;
  }

  /** 脚注文本（label → 定义文本；缺失时占位） */
  footnoteText(label) {
    const doc = this._currentDoc;
    const defs = doc && doc.footnotes ? doc.footnotes : {};
    return defs[label] != null ? defs[label] : `[缺少脚注 ${label}]`;
  }

  // ============ 函数调用 ============
  call(node) {
    const strArgs = (n) => n.args.filter((a) => a && a.type === 'string').map((a) => a.value);
    switch (node.name) {
      case 'cite': return `\\cite{${strArgs(node).join(',')}}`;
      case 'ref': return `\\ref{${strArgs(node)[0] || ''}}`;
      case 'term':
        return this.termText(strArgs(node)[0] || '');
      case 'bibliography': return this.bibliography();
      case 'glossary': return '';
      case 'if':
      case 'not':
      case 'and':
      case 'or':
      case 'set':
      case 'let':
      case 'define':
      case 'use':
      case 'plugin':
      case 'meta':
      case 'has_cite':
      case 'has_term':
        return ''; // 表达式/配置/功能类函数不产生 LaTeX 文本
      default: return this._note(`未知函数 @${node.name}`);
    }
  }

  /** 术语显示文本（runtime.data.terms） */
  termText(name) {
    const terms = this.runtime && this.runtime.data && this.runtime.data.terms;
    const entry = terms && terms[name];
    if (typeof entry === 'string') return escLatex(entry);
    if (entry && entry.label) return escLatex(entry.label);
    return escLatex(name);
  }

  /** @bibliography() → thebibliography（按引用顺序；条目文本简化自数据字段） */
  bibliography() {
    const bib = this.runtime && this.runtime.data && this.runtime.data.bibliography || {};
    const keys = (this.semantic && this.semantic.citeOrder || []).filter((k) => bib[k] !== undefined);
    if (!keys.length) return '';
    const lines = keys.map((key, i) => {
      const e = normalizeEntry(bib[key]);
      const parts = [];
      if (e.authors) parts.push(e.authors);
      if (e.year !== undefined) parts.push(`(${e.year})`);
      if (e.title) parts.push(e.title);
      if (e.container) parts.push(e.container);
      return `\\bibitem{${key}} ${parts.join(' ').replace(/[{}%$#_&]/g, '\\$1')}`;
    });
    return `\\begin{thebibliography}{9}\n${lines.join('\n')}\n\\end{thebibliography}`;
  }
}
