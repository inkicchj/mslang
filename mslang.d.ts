/**
 * mslang 类型声明（TS 宿主 + LLM 契约）
 * 对应 src/index.js 公共导出：render / Parser / dumpAST / BlockEditor / toJSON / llmReport
 */

// ---- 渲染选项 ----
export interface RenderOptions {
  /** 异步渲染：自定义函数返回 Promise 时需 true，返回 Promise<string> */
  async?: boolean;
  /** 块级渲染：返回 { html, blockHashes }（哨兵 + 变化检测哈希） */
  blocks?: boolean;
  /** 引用完整性检查：返回 { html, issues } */
  check?: boolean;
  /** 文献/术语数据：{ bibliography, terms } */
  data?: Record<string, any>;
  /** 变量表（表达式裸词引用） */
  variables?: Record<string, any>;
  /** 自定义函数表 */
  functions?: Record<string, (...args: any[]) => any>;
  /** 跨文档引用 loader：@include("path", "part") 时调用取文档源码；返回 Promise 需 async: true */
  include?: (path: string) => string | Promise<string>;
  wrapperClass?: string;
  wrapperId?: string;
  /** 标题自动编号：'1.1' / '1' / '一' */
  headingNumbering?: string | boolean;
  /** @ref 编号提取：'1' 数字 / '一' 中文 */
  refNumbering?: string;
  /** 编号前缀：fig/tbl/eq + thm 按类型（theorem/lemma/definition/remark/example） */
  captionPrefix?: Record<string, any>;
  citeKeyAttr?: string;
  termKeyAttr?: string;
  refKeyAttr?: string;
  /** 引用样式：numeric / author-year / author */
  citeStyle?: 'numeric' | 'author-year' | 'author';
  /** 文献表条目样式：default / gbt7714 */
  bibStyle?: 'default' | 'gbt7714';
  /** 允许文档内 @plugin（默认 false；文档 @set 无法打开，仅宿主显式开启） */
  allowPlugins?: boolean;
  escapeHtml?: boolean;
  pretty?: boolean;
  /** 公式渲染器（默认内置 KaTeX） */
  mathRenderer?: (src: string, inline: boolean) => string;
  mathFontsPath?: string;
  /** mermaid 渲染器（默认转义透传） */
  codeRenderer?: (source: string, language: string) => string;
}

export type RenderResult =
  | string
  | Promise<string>
  | { html: string; blockHashes: Record<number | 'footnotes', string> }
  | { html: string; issues: Issue[] };

export interface Issue {
  type: 'missing_cite' | 'missing_term' | 'missing_ref' | 'missing_footnote'
    | 'duplicate_label' | 'orphan_caption' | 'missing_include' | 'missing_part';
  key: string;
  count: number;
  /** 首次出现的块索引（文本层 issue 如 missing_include/missing_part 无块） */
  block?: number;
}

/** 唯一渲染入口：字符串渲染；数组自动合并；async/blocks/check 为配置项 */
export function render(source: string | string[] | Document, options?: RenderOptions): RenderResult;

/** 显式异步渲染：render(source, { async: true }) 别名 */
export function renderAsync(source: string | string[] | Document, options?: RenderOptions): Promise<string>;

/** 解析为 Stable AST：include 展开（可选）→ lex → parse → normalize */
export function parse(source: string): Document;

/** 语义分析入口（不渲染）：结构 + 编号/引用 + 完整诊断 */
export function analyze(source: string, options?: RenderOptions)
  : { document: Document; semantic: SemanticModel; diagnostics: Diagnostic[] } | Promise<{ document: Document; semantic: SemanticModel; diagnostics: Diagnostic[] }>;

export interface Diagnostic {
  code: 'missing-citation' | 'missing-term' | 'missing-reference' | 'missing-footnote'
    | 'duplicate-label' | 'orphan-caption' | 'missing-include' | 'missing-part';
  severity: 'warning';
  message: string;
  span?: { start: number; end: number };
  data: { label: string };
  block: number;
  count: number;
}

export interface SemanticModel {
  /** label → { kind, number|display, type? }（图/表/式/标题/定理/part） */
  refs: Record<string, any>;
  citeNumbers: Record<string, number>;
  citeOrder: string[];
  citeYearSuffix: Record<string, string>;
  termOrder: string[];
  headingSeq: string[];
}

/** 将 check issues 转为面向 LLM 的自查文本 */
export function llmReport(issues: Issue[]): string;

/** AST 结构化导出（LLM / 程序消费）：节点 → plain object（type 为节点类名） */
export function toJSON(node: any): any;

/** AST 调试打印（人类可读树） */
export function dumpAST(node: any): string;

export class Parser {
  /** Raw AST（纯语法，无结构归并/语义） */
  parseRaw(tokens: unknown[], source?: string): Document;
  /** Stable AST（兼容层：Raw + normalize + 区间 + 脚注编号） */
  parse(tokens: unknown[], source?: string): Document;
  /** Raw AST（字符串源） */
  parseTextRaw(source: string): Document;
  /** Stable AST（字符串源） */
  parseText(source: string): Document;
}

export interface Document {
  blocks: any[];
  footnotes: Record<string, string>;
}

/**
 * 块编辑封装（宿主块更新单一接口）。
 * 数据层：管理 source/hashes/块区间，内部完成 全量重渲 → diff → 局部/全量决策。
 */
export class BlockEditor {
  constructor(source: string, options?: RenderOptions);
  /** 初始渲染：切分每块 html + 脚注区（已剥离 wrapper） */
  render(): { blocks: Record<number, string>; footnotes: string; hashes: Record<string, string> };
  /** 编辑块 i：局部/全量决策返回变化块 html */
  update(i: number, newText: string): BlockUpdateResult;
  /** 以新源码重渲（逃生口：可改任意部分，含脚注定义行） */
  updateSource(newSource: string): BlockUpdateResult;
  setOptions(overrides: RenderOptions): void;
}

export interface BlockUpdateResult {
  changed: Array<number | 'footnotes'>;
  blocks: Record<number | 'footnotes', string>;
  /** true = 块数变化或变化块多，blocks 为全量 */
  full: boolean;
}
