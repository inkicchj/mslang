/**
 * mslang 语法解析器 (Parser) — JavaScript 实现
 *
 * 将词法解析器输出的 Token 流构建为抽象语法树 (AST)。
 *
 * 处理流程：
 *   1. 遍历 Token 流，按 BLANK_LINE / LINE_BREAK 边界分组为块
 *   2. 每个块根据首 Token 类型确定其 AST 节点类型
 *   3. 对块内的 RAW_TEXT，调用内联解析器提取行内节点
 *   4. 组装最终 Document 节点
 */

import { TokenType } from './tokens.js';
import { parseFunctionArgs } from './lexer.js';
import {
  Document,
  Heading, Paragraph, BlockQuote, CodeBlock,
  UnorderedList, OrderedList, ListItem, HorizontalRule,
  RawText, Bold, Italic, Strikethrough, InlineCode,
  Link, Image, LineBreak, FunctionCall, Color,
  Superscript, Subscript, RawHtml, FootnoteRef,
  Table, AlignBlock,
} from './nodes.js';

import { Lexer } from './lexer.js';

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
  parse(tokens) {
    this._tokens = tokens;
    this._pos = 0;
    this._footnoteDefs = {};

    const document = new Document();

    while (!this._isAtEnd()) {
      const block = this._parseBlock();
      if (block !== null) document.blocks.push(block);
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
    return this.parse(tokens);
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
        inlines.push(...this._parseInline(text));
        seenText = true;
        continue;
      }

      const inline = this._parseInlineToken();
      if (inline) {
        inlines.push(inline);
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

      if (token.type === TokenType.BLANK_LINE) break;

      break;
    }

    return new BlockQuote(this._mergeAdjacentText(inlines));
  }

  _parseCodeBlock() {
    const startToken = this._advance();
    const language = startToken.metadata.language || '';
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

    return new CodeBlock(language, codeLines.join('\n'));
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

    while (!this._isAtEnd()) {
      const token = this._current();
      if (token.type !== TokenType.TABLE_ROW && token.type !== TokenType.TABLE_SEP) break;

      const cells = token.metadata ? (token.metadata.cells || []) : [];
      this._advance();

      if (token.type === TokenType.TABLE_SEP) {
        hasSep = true;
        if (this._current() && this._current().type === TokenType.LINE_BREAK) this._advance();
        continue;
      }

      if (!hasSep) {
        headers.push(...cells);
      } else {
        rows.push(cells);
      }

      if (this._current() && this._current().type === TokenType.LINE_BREAK) this._advance();
    }

    return new Table(headers, rows);
  }

  _numberFootnotes(doc) {
    let counter = 0;
    const walk = (node) => {
      if (node instanceof FootnoteRef) {
        counter++;
        node.number = counter;
      }
      for (const attr of ['content', 'children', 'blocks', 'items']) {
        const children = node[attr];
        if (Array.isArray(children)) {
          for (const child of children) walk(child);
        }
      }
    };
    for (const block of doc.blocks) walk(block);
  }

  _parseFootnoteDef() {
    const token = this._advance();
    const label = token.metadata.label || '';
    this._footnoteDefs[label] = token.value;
    return null;
  }

  _parseAlign(token) {
    this._advance();
    const align = token.type === TokenType.ALIGN_RIGHT ? 'right' : 'center';
    const inlines = this._parseInline(token.value);
    return new AlignBlock(align, this._mergeAdjacentText(inlines));
  }

  _parseInlineToken() {
    const token = this._current();

    if (token.type === TokenType.BOLD) {
      this._advance();
      return new Bold(this._parseInline(token.value));
    }
    if (token.type === TokenType.ITALIC) {
      this._advance();
      return new Italic(this._parseInline(token.value));
    }
    if (token.type === TokenType.STRIKETHROUGH) {
      this._advance();
      return new Strikethrough(this._parseInline(token.value));
    }
    if (token.type === TokenType.INLINE_CODE) {
      this._advance();
      return new InlineCode(token.value);
    }
    if (token.type === TokenType.LINK) {
      this._advance();
      return new Link(token.value, token.metadata.url || '');
    }
    if (token.type === TokenType.IMAGE) {
      this._advance();
      return new Image(
        token.value,
        token.metadata.url || '',
        token.metadata.width || '',
      );
    }
    if (token.type === TokenType.FUNCTION_CALL) {
      this._advance();
      return new FunctionCall(
        token.value,
        token.metadata.args || [],
        token.metadata.kwargs || {},
        token.metadata.raw_args || '',
      );
    }
    if (token.type === TokenType.COLOR) {
      this._advance();
      return new Color(token.metadata.color || '', token.value);
    }
    if (token.type === TokenType.SUPERSCRIPT) {
      this._advance();
      return new Superscript(this._parseInline(token.value));
    }
    if (token.type === TokenType.SUBSCRIPT) {
      this._advance();
      return new Subscript(this._parseInline(token.value));
    }
    if (token.type === TokenType.FOOTNOTE_REF) {
      this._advance();
      return new FootnoteRef(token.value);
    }

    return null;
  }

  /**
   * 解析一个纯文本字符串中的行内元素
   * @param {string} text
   * @returns {import('./nodes.js').InlineNode[]}
   */
  _parseInline(text) {
    if (!text) return [];

    const inlines = [];
    let i = 0;

    while (i < text.length) {
      let matched = false;

      // **bold**
      if (text.startsWith('**', i)) {
        const end = text.indexOf('**', i + 2);
        if (end !== -1) {
          const inner = text.slice(i + 2, end);
          inlines.push(new Bold(this._parseInline(inner)));
          i = end + 2;
          matched = true;
        }
      }
      // __bold__
      else if (text.startsWith('__', i)) {
        const end = text.indexOf('__', i + 2);
        if (end !== -1) {
          const inner = text.slice(i + 2, end);
          inlines.push(new Bold(this._parseInline(inner)));
          i = end + 2;
          matched = true;
        }
      }
      // *italic*
      else if (text[i] === '*' && !text.startsWith('**', i)) {
        const end = text.indexOf('*', i + 1);
        if (end !== -1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Italic(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      }
      // _italic_
      else if (text[i] === '_' && !text.startsWith('__', i)) {
        const end = text.indexOf('_', i + 1);
        if (end !== -1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Italic(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      }
      // ~~strikethrough~~
      else if (text.startsWith('~~', i)) {
        const end = text.indexOf('~~', i + 2);
        if (end !== -1) {
          const inner = text.slice(i + 2, end);
          inlines.push(new Strikethrough(this._parseInline(inner)));
          i = end + 2;
          matched = true;
        }
      }
      // ~subscript~
      else if (text[i] === '~' && !text.startsWith('~~', i)) {
        const end = text.indexOf('~', i + 1);
        if (end !== -1 && end > i + 1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Subscript(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      }
      // ^superscript^
      else if (text[i] === '^') {
        const end = text.indexOf('^', i + 1);
        if (end !== -1 && end > i + 1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Superscript(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      }
      // `inline code`
      else if (text[i] === '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) {
          const code = text.slice(i + 1, end);
          inlines.push(new InlineCode(code));
          i = end + 1;
          matched = true;
        }
      }
      // [link](url) or [^footnote]
      else if (text[i] === '[') {
        if (i + 1 < text.length && text[i + 1] === '^') {
          const end = text.indexOf(']', i + 2);
          if (end !== -1) {
            const label = text.slice(i + 2, end);
            inlines.push(new FootnoteRef(label));
            i = end + 1;
            matched = true;
          }
        } else {
          const textEnd = text.indexOf(']', i + 1);
          if (textEnd !== -1 && textEnd + 1 < text.length && text[textEnd + 1] === '(') {
            const urlEnd = text.indexOf(')', textEnd + 2);
            if (urlEnd !== -1) {
              const linkText = text.slice(i + 1, textEnd);
              const url = text.slice(textEnd + 2, urlEnd);
              inlines.push(new Link(linkText, url));
              i = urlEnd + 1;
              matched = true;
            }
          }
        }
      }
      // ![image](url)
      else if (text.startsWith('![', i)) {
        const altEnd = text.indexOf(']', i + 2);
        if (altEnd !== -1 && altEnd + 1 < text.length && text[altEnd + 1] === '(') {
          const urlEnd = text.indexOf(')', altEnd + 2);
          if (urlEnd !== -1) {
            const alt = text.slice(i + 2, altEnd);
            const urlRaw = text.slice(altEnd + 2, urlEnd).trim();
            let url = urlRaw;
            let width = '';
            if (urlRaw.includes(' ')) {
              const parts = urlRaw.split(' ');
              const last = parts[parts.length - 1];
              if (last.endsWith('%') && /^\d+%$/.test(last)) {
                url = parts.slice(0, -1).join(' ');
                width = last;
              }
            }
            inlines.push(new Image(alt, url, width));
            i = urlEnd + 1;
            matched = true;
          }
        }
      }
      // @function(args)
      else if (text[i] === '@') {
        let j = i + 1;
        while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++;
        if (j > i + 1 && j < text.length && text[j] === '(') {
          const rp = text.indexOf(')', j + 1);
          if (rp !== -1) {
            const name = text.slice(i + 1, j);
            const rawArgs = text.slice(j + 1, rp);
            const { args, kwargs } = parseFunctionArgs(rawArgs);
            inlines.push(new FunctionCall(name, args, kwargs, rawArgs));
            i = rp + 1;
            matched = true;
          }
        }
      }
      // /#hex:text:/
      else if (text.startsWith('/#', i)) {
        let j = i + 2;
        while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
        const hexLen = j - i - 2;
        if ([3, 6].includes(hexLen) && j < text.length && text[j] === ':') {
          const end = text.indexOf(':/', j + 1);
          if (end !== -1) {
            const color = text.slice(i + 2, j);
            const inner = text.slice(j + 1, end);
            inlines.push(new Color(color, inner));
            i = end + 2;
            matched = true;
          }
        }
      }

      // 转义: \* → *
      if (!matched && text[i] === '\\') {
        const specials = new Set(['*', '_', '~', '`', '[', '!', '@', '/', '\\']);
        if (i + 1 < text.length && specials.has(text[i + 1])) {
          inlines.push(new RawText(text[i + 1]));
          i += 2;
          matched = true;
        }
      }

      // HTML 透传
      if (!matched && text[i] === '<') {
        const end = text.indexOf('>', i + 1);
        if (end !== -1) {
          inlines.push(new RawHtml(text.slice(i, end + 1)));
          i = end + 1;
          matched = true;
        }
      }

      if (!matched) {
        let j = i + 1;
        const specials = new Set(['*', '_', '~', '`', '[', '!', '@', '\\', '^', '<']);
        while (j < text.length && !specials.has(text[j])) j++;
        inlines.push(new RawText(text.slice(i, j)));
        i = j;
      }
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
    return [
      TokenType.HEADING, TokenType.HORIZONTAL_RULE, TokenType.BLOCKQUOTE,
      TokenType.UNORDERED_LIST, TokenType.ORDERED_LIST,
      TokenType.TABLE_ROW, TokenType.TABLE_SEP,
      TokenType.ALIGN_RIGHT, TokenType.ALIGN_CENTER,
      TokenType.BLANK_LINE, TokenType.EOF,
    ].includes(token.type) || (
      token.type === TokenType.CODE_BLOCK &&
      token.metadata &&
      ['start', 'end'].includes(token.metadata.fence_type)
    );
  }

  // ================================================================
  // 调试 — AST 打印
  // ================================================================

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
    const lines = [`${linePrefix}CodeBlock (lang=${JSON.stringify(node.language)})`];
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
    return `${linePrefix}FunctionCall @${node.name}(${argsRepr})`;
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
  if (node instanceof Link) return `${linePrefix}Link "${node.text}" -> ${node.url}`;
  if (node instanceof Image) return `${linePrefix}Image alt="${node.alt}" src="${node.url}"`;
  if (node instanceof RawText) return `${linePrefix}Text "${node.text}"`;
  if (node instanceof LineBreak) return `${linePrefix}LineBreak`;

  return `${linePrefix}${name}`;
}

export { Parser, ParserError, dumpAST };
