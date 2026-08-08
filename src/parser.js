/**
 * mslang 语法解析器 (Parser) — JavaScript 实现
 *
 * 将词法解析器输出的 Token 流构建为抽象语法树 (AST)。
 *
 * 处理流程：
 *   1. 遍历 Token 流，按 BLANK_LINE / LINE_BREAK 边界分组为块
 *   2. 每个块根据首 Token 类型确定其 AST 节点类型
 *   3. 块内容中的行内元素已由 Lexer 识别为 Token，直接映射为 AST 节点
 *   4. 组装最终 Document 节点
 */

import { TokenType } from './tokens.js';
import { Lexer } from './lexer.js';
import { parseArgs } from './expression.js';
import {
  Document,
  Heading, Paragraph, BlockQuote, CodeBlock,
  UnorderedList, OrderedList, ListItem, HorizontalRule,
  RawText, Bold, Italic, Strikethrough, InlineCode,
  Link, Image, LineBreak, FunctionCall, Color,
  Superscript, Subscript, RawHtml, FootnoteRef,
  Table, AlignBlock, Caption, Equation,
} from './nodes.js';

// 会终止段落/引用的块级 Token 类型
const BLOCK_BOUNDARY_TYPES = new Set([
  TokenType.HEADING, TokenType.HORIZONTAL_RULE, TokenType.BLOCKQUOTE,
  TokenType.UNORDERED_LIST, TokenType.ORDERED_LIST,
  TokenType.TABLE_ROW, TokenType.TABLE_SEP,
  TokenType.ALIGN_RIGHT, TokenType.ALIGN_CENTER,
  TokenType.BLANK_LINE, TokenType.EOF,
]);

// ================================================================
// ParserError
// ================================================================

class ParserError extends Error {
  constructor(message, token = null) {
    const loc = token ? ` [${token.position}]` : '';
    super(`ParseError${loc}: ${message}`);
    this.token = token;
  }
}

// ================================================================
// Parser
// ================================================================

const URL_RE = /^(https?:\/\/[^\s<>"{}|\\^`]+)$/;           // 全串 URL
const URL_FIND_RE = /https?:\/\/[^\s<>"{}|\\^`]+/g;         // 嵌入 URL

class Parser {
  constructor() {
    this._tokens = [];
    this._pos = 0;
    this._footnoteDefs = {};
  }

  // ================================================================
  // 公共接口
  // ================================================================

  /**
   * 将 Token 列表解析为 Document AST
   * @param {import('./tokens.js').Token[]} tokens
   * @returns {Document}
   */
  parse(tokens, source = '') {
    this._tokens = tokens;
    this._pos = 0;
    this._footnoteDefs = {};
    this._footnoteDefPositions = [];
    this._source = source;

    const document = new Document();

    while (!this._isAtEnd()) {
      const startPos = this._current().position.index;
      const block = this._parseBlock();
      if (block === null) continue;
      // 图表 caption：归并到前一块（表格/单图片段落），孤立时降级为普通段落
      if (block instanceof Caption) {
        const target = this._captionTarget(document.blocks[document.blocks.length - 1], block.label);
        if (target) {
          target.caption = block.content;
          continue;
        }
        // 孤立 caption 降级为普通段落：{#label} 前缀保留原文，
        // 剩余部分走行内解析（避免 {# 被重新识别为 CAPTION token）
        const prefix = `{#${block.label}}`;
        const rest = block.raw.startsWith(prefix) ? block.raw.slice(prefix.length) : block.raw;
        const inlines = [new RawText(prefix), ...this._parseInline(rest)];
        const para = new Paragraph(this._mergeAdjacentText(inlines));
        para.startPos = startPos;
        document.blocks.push(para);
        continue;      }
      block.startPos = startPos;
      document.blocks.push(block);
    }

    // 块源区间：[startPos, 下一块 startPos)，末块到文档末尾（caption 归并行自然落入前块区间）
    // 脚注定义行不属于任何块：区间截断到其后的第一个脚注定义位置
    for (let i = 0; i < document.blocks.length; i++) {
      const b = document.blocks[i];
      let end = i + 1 < document.blocks.length ? document.blocks[i + 1].startPos : source.length;
      for (const p of this._footnoteDefPositions) {
        if (p >= b.startPos && p < end) { end = p; break; }
      }
      b.endPos = end;
      if (source) b.raw = source.slice(b.startPos, b.endPos);
    }

    if (Object.keys(this._footnoteDefs).length > 0) {
      document.footnotes = { ...this._footnoteDefs };
      this._numberFootnotes(document);
    }

    return document;
  }

  /**
   * 直接解析原始文本（内部调用 Lexer）
   * @param {string} source
   * @returns {Document}
   */
  parseText(source) {
    const lexer = new Lexer(source);
    const tokens = lexer.tokenize();
    return this.parse(tokens, source);
  }

  // ================================================================
  // 块级解析
  // ================================================================

  _parseBlock() {
    const token = this._current();

    // 跳过行间空白
    if (token.type === TokenType.LINE_BREAK) {
      this._advance();
      return null;
    }

    // 段落分隔空白行
    if (token.type === TokenType.BLANK_LINE) {
      this._advance();
      let extraBlanks = 0;
      // 连续 BLANK_LINE → 计数
      while (this._current() && this._current().type === TokenType.BLANK_LINE) {
        this._advance();
        extraBlanks++;
      }
      // 奇数个 \n 的剩余 LINE_BREAK 也算一次间距
      if (this._current() && this._current().type === TokenType.LINE_BREAK) {
        this._advance();
        if (this._current() && this._current().type === TokenType.BLANK_LINE) {
          extraBlanks++;
          this._advance();
          while (this._current() && this._current().type === TokenType.BLANK_LINE) {
            this._advance();
            extraBlanks++;
          }
        } else {
          extraBlanks++;
        }
      }
      if (extraBlanks > 0) {
        const breaks = [];
        for (let i = 0; i < extraBlanks; i++) breaks.push(new LineBreak());
        return new Paragraph(breaks);
      }
      return null;
    }

    // 标题
    if (token.type === TokenType.HEADING) return this._parseHeading();

    // 分割线
    if (token.type === TokenType.HORIZONTAL_RULE) {
      this._advance();
      return new HorizontalRule();
    }

    // 引用块
    if (token.type === TokenType.BLOCKQUOTE) return this._parseBlockquote();

    // 代码块
    if (token.type === TokenType.CODE_BLOCK &&
        token.metadata && token.metadata.fence_type === 'start') {
      return this._parseCodeBlock();
    }

    // 无序列表
    if (token.type === TokenType.UNORDERED_LIST) return this._parseUnorderedList();

    // 有序列表
    if (token.type === TokenType.ORDERED_LIST) return this._parseOrderedList();

    // 表格
    if (token.type === TokenType.TABLE_ROW) return this._parseTable();

    // 脚注定义
    if (token.type === TokenType.FOOTNOTE_DEF) return this._parseFootnoteDef();

    // 对齐
    if (token.type === TokenType.ALIGN_RIGHT || token.type === TokenType.ALIGN_CENTER) {
      return this._parseAlign(token);
    }

    // 图表 caption（{#label} 说明，归并到前一块或降级为段落）
    if (token.type === TokenType.CAPTION) return this._parseCaption(token);

    // 块级公式（$$...$$）
    if (token.type === TokenType.MATH && !token.metadata.inline) return this._parseMath(token);

    // 默认为段落
    if (token.type === TokenType.RAW_TEXT || token.type.value >= TokenType.BOLD.value) {
      return this._parseParagraph();
    }

    this._advance();
    return null;
  }

  _parseHeading() {
    const token = this._advance();
    const level = token.metadata.level || 1;
    const headingId = token.metadata.id || '';
    const inlines = this._parseInline(token.value);
    return new Heading(level, inlines, headingId);
  }

  _parseParagraph() {
    const inlines = [];
    let seenText = false;

    while (!this._isAtEnd()) {
      const token = this._current();

      if (this._isBlockBoundary(token)) break;

      if (token.type === TokenType.LINE_BREAK) {
        this._advance();
        const nt = this._current();
        if (nt && this._isBlockBoundary(nt)) break;
        inlines.push(new LineBreak());
        continue;
      }

      if (token.type === TokenType.RAW_TEXT) {
        const text = token.value;
        this._advance();
        // Lexer 已保证 RAW_TEXT 为纯文本，这里仅需识别其中的裸 URL
        inlines.push(...this._autolink([new RawText(text)]));
        seenText = true;
        continue;
      }

      const inline = this._parseInlineToken(token);
      if (inline) {
        inlines.push(inline);
        this._advance();
        seenText = true;
      } else {
        this._advance();
      }
    }

    if (!seenText) return new Paragraph([new RawText('')]);
    return new Paragraph(this._mergeAdjacentText(inlines));
  }

  _parseBlockquote() {
    const inlines = [];

    while (!this._isAtEnd()) {
      const token = this._current();

      if (token.type === TokenType.BLOCKQUOTE) {
        this._advance();
        inlines.push(...this._parseInline(token.value));
        continue;
      }

      if (token.type === TokenType.LINE_BREAK) {
        this._advance();
        const nt = this._current();
        if (nt && nt.type === TokenType.BLOCKQUOTE) {
          inlines.push(new LineBreak());
          continue;
        }
        break;
      }

      break;
    }

    return new BlockQuote(this._mergeAdjacentText(inlines));
  }

  _parseCodeBlock() {
    const startToken = this._advance();
    const language = startToken.metadata.language || '';
    const label = startToken.metadata.label || '';
    const codeLines = [];

    while (!this._isAtEnd()) {
      const token = this._current();

      if (token.type === TokenType.CODE_BLOCK &&
          token.metadata && token.metadata.fence_type === 'end') {
        this._advance();
        break;
      }

      if (token.type === TokenType.RAW_TEXT &&
          token.metadata && token.metadata.in_code_block) {
        codeLines.push(token.value);
        this._advance();
        continue;
      }

      if (token.type === TokenType.LINE_BREAK) {
        this._advance();
        continue;
      }

      this._advance();
    }

    // 去除首尾空行
    while (codeLines.length && codeLines[0] === '') codeLines.shift();
    while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();

    return new CodeBlock(language, codeLines.join('\n'), label);
  }

  _parseUnorderedList() {
    return new UnorderedList(this._parseListItems(TokenType.UNORDERED_LIST));
  }

  _parseOrderedList() {
    return new OrderedList(this._parseListItems(TokenType.ORDERED_LIST));
  }

  _parseListItems(listType) {
    const items = [];

    // skip leading LINE_BREAK
    while (this._current() && this._current().type === TokenType.LINE_BREAK) {
      this._advance();
    }

    const firstToken = this._current();
    const baseIndent = (firstToken && firstToken.metadata) ? (firstToken.metadata.indent || 0) : 0;

    while (!this._isAtEnd()) {
      const token = this._current();

      if (token.type === listType) {
        const tokenIndent = token.metadata.indent || 0;
        if (tokenIndent < baseIndent) break;

        this._advance();
        const inlines = this._parseInline(token.value);
        const item = new ListItem(this._mergeAdjacentText(inlines));

        // 检测任务列表标记 [ ] 或 [x]
        if (item.content.length && item.content[0] instanceof RawText) {
          const t = item.content[0].text;
          if (t.startsWith('[ ] ')) {
            item.checked = false;
            item.content[0] = new RawText(t.slice(4));
          } else if (t.startsWith('[x] ') || t.startsWith('[X] ')) {
            item.checked = true;
            item.content[0] = new RawText(t.slice(4));
          }
        }

        // 检查嵌套子列表
        const nt = this._peekPastBreaks();
        if (nt && (nt.type === TokenType.UNORDERED_LIST || nt.type === TokenType.ORDERED_LIST)) {
          const nextIndent = nt.metadata ? (nt.metadata.indent || 0) : 0;
          if (nextIndent > baseIndent) {
            if (nt.type === TokenType.UNORDERED_LIST) {
              item.children = [new UnorderedList(this._parseListItems(TokenType.UNORDERED_LIST))];
            } else {
              item.children = [new OrderedList(this._parseListItems(TokenType.ORDERED_LIST))];
            }
          }
        }

        items.push(item);
        continue;
      }

      if (token.type === TokenType.LINE_BREAK) {
        this._advance();
        const nextToken = this._current();
        if (nextToken && nextToken.type === listType) continue;
        else break;
      }

      if (token.type === TokenType.BLANK_LINE) break;

      break;
    }

    return items;
  }

  // ================================================================
  // 行内解析
  // ================================================================

  _parseTable() {
    const headers = [];
    const rows = [];
    let hasSep = false;
    let label = '';

    while (!this._isAtEnd()) {
      const token = this._current();
      if (token.type !== TokenType.TABLE_ROW && token.type !== TokenType.TABLE_SEP) break;

      let cells = token.metadata ? (token.metadata.cells || []) : [];
      this._advance();

      if (token.type === TokenType.TABLE_SEP) {
        hasSep = true;
        if (this._current() && this._current().type === TokenType.LINE_BREAK) this._advance();
        continue;
      }

      if (!hasSep) {
        // 表头行：末尾单元格 {#label} 作为表格交叉引用标签
        if (headers.length === 0) {
          const last = cells.length ? cells[cells.length - 1] : '';
          const m = last.match(/^\{#([^}]+)\}$/);
          if (m) {
            label = m[1];
            cells = cells.slice(0, -1);
          }
        }
        headers.push(...cells);
      } else {
        rows.push(cells);
      }

      if (this._current() && this._current().type === TokenType.LINE_BREAK) this._advance();
    }

    return new Table(headers, rows, label);
  }

  _numberFootnotes(doc) {
    let counter = 0;
    for (const block of doc.blocks) {
      _walkNodes(block, (node) => {
        if (node instanceof FootnoteRef) {
          counter++;
          node.number = counter;
        }
      });
    }
  }

  /**
   * 查找 caption 的归并目标：前一 block 是 label 匹配的表格，
   * 或仅含单个 label 匹配图片的段落（图片需单独成段）。
   */
  _captionTarget(prev, label) {
    if (!prev) return null;
    if (prev instanceof Table && prev.label === label) return prev;
    if (prev instanceof CodeBlock && prev.label === label) return prev;
    if (prev instanceof Equation && prev.label === label) return prev;
    if (prev instanceof Paragraph && prev.content.length === 1 &&
        prev.content[0] instanceof Image && prev.content[0].label === label) {
      return prev.content[0];
    }
    return null;
  }

  _parseMath(token) {
    this._advance();
    return new Equation(token.value, token.metadata.inline, token.metadata.label || '');
  }

  _parseCaption(token) {
    this._advance();
    const label = token.metadata.label || '';
    const content = this._mergeAdjacentText(this._parseInline(token.value));
    return new Caption(label, content, token.metadata.raw || '');
  }

  _parseFootnoteDef() {
    const token = this._advance();
    const label = token.metadata.label || '';
    this._footnoteDefs[label] = token.value;
    this._footnoteDefPositions.push(token.position.index);
    return null;
  }

  _parseAlign(token) {
    this._advance();
    const align = token.type === TokenType.ALIGN_RIGHT ? 'right' : 'center';
    const inlines = this._parseInline(token.value);
    return new AlignBlock(align, this._mergeAdjacentText(inlines));
  }

  _parseInlineToken(token) {
    if (token.type === TokenType.MATH) {
      return new Equation(token.value, token.metadata.inline, token.metadata.label || '');
    }
    if (token.type === TokenType.BOLD) {
      return new Bold(this._parseInline(token.value));
    }
    if (token.type === TokenType.ITALIC) {
      return new Italic(this._parseInline(token.value));
    }
    if (token.type === TokenType.STRIKETHROUGH) {
      return new Strikethrough(this._parseInline(token.value));
    }
    if (token.type === TokenType.INLINE_CODE) {
      return new InlineCode(token.value);
    }
    if (token.type === TokenType.LINK) {
      return new Link(token.value, token.metadata.url || '');
    }
    if (token.type === TokenType.IMAGE) {
      return new Image(
        token.value,
        token.metadata.url || '',
        token.metadata.width || '',
        token.metadata.label || '',
      );
    }
    if (token.type === TokenType.FUNCTION_CALL) {
      const rawArgs = token.metadata.raw_args || '';
      let args = [];
      let kwargs = {};
      let error = '';
      try {
        ({ args, kwargs } = parseArgs(rawArgs));
      } catch (e) {
        error = e.message;
      }
      return new FunctionCall(token.value, args, kwargs, rawArgs, error);
    }
    if (token.type === TokenType.COLOR) {
      return new Color(token.metadata.color || '', token.value);
    }
    if (token.type === TokenType.SUPERSCRIPT) {
      return new Superscript(this._parseInline(token.value));
    }
    if (token.type === TokenType.SUBSCRIPT) {
      return new Subscript(this._parseInline(token.value));
    }
    if (token.type === TokenType.FOOTNOTE_REF) {
      return new FootnoteRef(token.value);
    }
    if (token.type === TokenType.RAW_HTML) {
      return new RawHtml(token.value);
    }

    return null;
  }

  /**
   * 解析一个纯文本字符串中的行内元素。
   * 行内语法识别全部交由 Lexer 完成，本方法只做 Token → AST 映射与递归。
   * @param {string} text
   * @returns {import('./nodes.js').InlineNode[]}
   */
  _parseInline(text) {
    if (!text) return [];

    const tokens = new Lexer(text).tokenize();
    const inlines = [];
    for (const token of tokens) {
      if (token.type === TokenType.EOF) break;
      // RAW_TEXT 已被 Lexer 保证为纯文本；换行保持为文本（软换行语义）
      if (token.type === TokenType.RAW_TEXT ||
          token.type === TokenType.LINE_BREAK ||
          token.type === TokenType.BLANK_LINE) {
        inlines.push(new RawText(token.value));
        continue;
      }
      const node = this._parseInlineToken(token);
      if (node) inlines.push(node);
    }
    return this._mergeAdjacentText(this._autolink(inlines));
  }

  // ================================================================
  // 辅助方法
  // ================================================================

  /** 合并相邻的 RawText 节点 */
  _mergeAdjacentText(nodes) {
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

  /** 检测 RawText 中的裸 URL 并转为 Link，支持嵌入文本中的 URL */
  _autolink(nodes) {
    const result = [];
    for (const node of nodes) {
      if (!(node instanceof RawText)) {
        result.push(node);
        continue;
      }

      const text = node.text;
      if (!text) {
        result.push(node);
        continue;
      }

      // 快速路径：整条文本就是 URL
      if (URL_RE.test(text)) {
        result.push(new Link(text, text));
        continue;
      }

      // 在文本中搜索嵌入的 URL
      URL_FIND_RE.lastIndex = 0;
      let lastIndex = 0;
      let match;
      let found = false;

      while ((match = URL_FIND_RE.exec(text)) !== null) {
        found = true;
        // URL 前的普通文本
        if (match.index > lastIndex) {
          result.push(new RawText(text.slice(lastIndex, match.index)));
        }
        // URL 转为 Link
        result.push(new Link(match[0], match[0]));
        lastIndex = URL_FIND_RE.lastIndex;
      }

      if (!found) {
        result.push(node);
      } else if (lastIndex < text.length) {
        // URL 后的剩余文本
        result.push(new RawText(text.slice(lastIndex)));
      }
    }
    return result;
  }

  _current() {
    if (this._pos < this._tokens.length) return this._tokens[this._pos];
    return null;
  }

  _advance() {
    const token = this._tokens[this._pos];
    this._pos++;
    return token;
  }

  _peekPastBreaks(offset = 0) {
    let p = this._pos + offset;
    while (p < this._tokens.length && this._tokens[p].type === TokenType.LINE_BREAK) {
      p++;
    }
    if (p < this._tokens.length) return this._tokens[p];
    return null;
  }

  _isAtEnd() {
    if (this._pos >= this._tokens.length) return true;
    return this._tokens[this._pos].type === TokenType.EOF;
  }

  _isBlockBoundary(token) {
    if (BLOCK_BOUNDARY_TYPES.has(token.type)) return true;
    return token.type === TokenType.CODE_BLOCK &&
      token.metadata &&
      ['start', 'end'].includes(token.metadata.fence_type);
  }

  // ================================================================
  // 调试 — AST 打印
  // ================================================================

  /** 委托给模块级 dumpAST（下方定义，供调试打印 AST） */
  dumpAST(node) {
    return dumpAST(node);
  }
}

// ================================================================
// 模块级 AST 打印函数
// ================================================================

function _isSpacer(node) {
  return node instanceof Paragraph &&
    node.content.length > 0 &&
    node.content.every(n => n instanceof LineBreak);
}

/**
 * 深度遍历 AST 节点（递归穿过 content/children/blocks/items 数组属性）。
 * _numberFootnotes 与 mergeDocuments 共用。
 */
function _walkNodes(node, fn) {
  fn(node);
  for (const attr of ['content', 'children', 'blocks', 'items']) {
    const children = node[attr];
    if (Array.isArray(children)) {
      for (const child of children) _walkNodes(child, fn);
    }
  }
}

/**
 * 合并多个 Document 为一个，供跨文档连续编号 / 交叉引用 / 全局 @set：
 *   - blocks 按传入顺序拼接（顺序即编号顺序）
 *   - 脚注跨文档重编号：引用按出现顺序编号，footnotes 字典同步重排
 *   - 同名脚注 label 后者覆盖
 */
function mergeDocuments(...docs) {
  const blocks = [];
  const footnotes = {};
  for (const doc of docs) {
    blocks.push(...doc.blocks);
    Object.assign(footnotes, doc.footnotes);
  }
  const ordered = {};
  let counter = 0;
  for (const block of blocks) {
    _walkNodes(block, (node) => {
      if (node instanceof FootnoteRef && footnotes[node.label] !== undefined) {
        counter++;
        node.number = counter;
        ordered[node.label] = footnotes[node.label];
      }
    });
  }
  // 未被引用的脚注定义追加到末尾
  for (const [label, text] of Object.entries(footnotes)) {
    if (!(label in ordered)) ordered[label] = text;
  }
  return new Document(blocks, ordered);
}

function _dumpInlines(nodes, indent, prefix) {
  const lines = [];
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    lines.push(dumpAST(n, indent, prefix, last));
  });
  return lines;
}

function dumpAST(node, indent = 0, prefix = '', isLast = true) {
  const connector = isLast ? '└── ' : '├── ';
  const continuation = isLast ? '    ' : '│   ';
  const linePrefix = indent === 0 ? '' : prefix + connector;

  const name = node.constructor.name;

  // Document
  if (node instanceof Document) {
    const lines = ['Document'];
    node.blocks.forEach((block, i) => {
      const last = i === node.blocks.length - 1;
      lines.push(dumpAST(block, indent + 1, '', last));
    });
    return lines.join('\n');
  }

  // Block nodes
  if (node instanceof Heading) {
    const lines = [`${linePrefix}Heading (level=${node.level})`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }

  if (node instanceof Paragraph) {
    if (_isSpacer(node)) return `${linePrefix}Spacer (x${node.content.length} <br>)`;
    const lines = [`${linePrefix}Paragraph`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }

  if (node instanceof BlockQuote) {
    const lines = [`${linePrefix}BlockQuote`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }

  if (node instanceof CodeBlock) {
    const lbl = node.label ? ` label=${node.label}` : '';
    const lines = [`${linePrefix}CodeBlock (lang=${JSON.stringify(node.language)})${lbl}`];
    const codePreview = node.code.trim();
    codePreview.split('\n').forEach(cl => {
      lines.push(`${continuation}│   ${cl}`);
    });
    return lines.join('\n');
  }

  if (node instanceof UnorderedList) {
    const lines = [`${linePrefix}UnorderedList`];
    node.items.forEach((item, i) => {
      const last = i === node.items.length - 1;
      lines.push(dumpAST(item, indent + 1, continuation, last));
    });
    return lines.join('\n');
  }

  if (node instanceof OrderedList) {
    const lines = [`${linePrefix}OrderedList`];
    node.items.forEach((item, i) => {
      const last = i === node.items.length - 1;
      lines.push(dumpAST(item, indent + 1, continuation, last));
    });
    return lines.join('\n');
  }

  if (node instanceof ListItem) {
    const lines = [`${linePrefix}ListItem`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }

  if (node instanceof HorizontalRule) return `${linePrefix}HorizontalRule`;

  if (node instanceof AlignBlock) {
    const lines = [`${linePrefix}AlignBlock (${node.align})`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }

  // Inline nodes
  if (node instanceof FunctionCall) {
    const argsRepr = node.rawArgs || '';
    const err = node.error ? `  !ERROR: ${node.error}` : '';
    return `${linePrefix}FunctionCall @${node.name}(${argsRepr})${err}`;
  }
  if (node instanceof Color) return `${linePrefix}Color #${node.color} "${node.text}"`;
  if (node instanceof Superscript) {
    const lines = [`${linePrefix}Superscript`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }
  if (node instanceof Subscript) {
    const lines = [`${linePrefix}Subscript`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }
  if (node instanceof RawHtml) return `${linePrefix}RawHtml ${node.html}`;
  if (node instanceof FootnoteRef) return `${linePrefix}FootnoteRef [${node.label}] #${node.number}`;
  if (node instanceof Bold) {
    const lines = [`${linePrefix}Bold`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }
  if (node instanceof Italic) {
    const lines = [`${linePrefix}Italic`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }
  if (node instanceof Strikethrough) {
    const lines = [`${linePrefix}Strikethrough`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join('\n');
  }
  if (node instanceof InlineCode) return `${linePrefix}InlineCode \`${node.code}\``;
  if (node instanceof Equation) {
    const lbl = node.label ? ` label=${node.label}` : '';
    return `${linePrefix}Equation ${node.inline ? 'inline' : 'block'} "${node.source}"${lbl}`;
  }
  if (node instanceof Link) return `${linePrefix}Link "${node.text}" -> ${node.url}`;
  if (node instanceof Image) {
    const lbl = node.label ? ` label=${node.label}` : '';
    return `${linePrefix}Image alt="${node.alt}" src="${node.url}"${lbl}`;
  }
  if (node instanceof Table) {
    const lbl = node.label ? ` (label=${node.label})` : '';
    return `${linePrefix}Table${lbl}`;
  }
  if (node instanceof RawText) return `${linePrefix}Text "${node.text}"`;
  if (node instanceof LineBreak) return `${linePrefix}LineBreak`;

  return `${linePrefix}${name}`;
}

export { Parser, ParserError, dumpAST, mergeDocuments };
