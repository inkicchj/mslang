/**
 * mslang 词法解析器 (Lexer) — JavaScript 实现
 *
 * 将源文本扫描为 Token 流。采用两阶段策略：
 *   1. 块级扫描：按行识别标题、代码块、列表、引用、分割线、段落边界
 *   2. 行内扫描：在段落/标题等块内容中识别加粗、斜体、链接等行内元素
 */

import { TokenType, Position, Token, CHAR } from './tokens.js';

// ================================================================
// LexerError
// ================================================================

class LexerError extends Error {
  constructor(message, position) {
    super(`[${position}] ${message}`);
    this.position = position;
  }
}

// ================================================================
// Lexer
// ================================================================

const RE_HEADING         = /^(#{1,6})\s+(.+)$/;
const RE_HORIZONTAL_RULE = /^(\s{0,3})([-*_])\s*\2\s*\2[ \2]*$/;
const RE_BLOCKQUOTE      = /^>\s?(.*)$/;
const RE_UNORDERED_LIST  = /^(\s*)([-*+])\s+(.+)$/;
const RE_ORDERED_LIST    = /^(\s*)(\d+)\.\s+(.+)$/;
const RE_FOOTNOTE_DEF    = /^\[\^([^\]]+)\]:\s+(.+)$/;
const RE_TABLE           = /^\|(.+)\|$/;
const RE_ALIGN_RIGHT     = /^>>\s+(.+)$/;
const RE_ALIGN_CENTER    = /^-><-\s+(.+)$/;
const RE_CAPTION         = /^\{#([^}]+)\}\s?(.*)$/;

// 可被反斜杠转义的字符（与行内语法起始符一致）
const ESCAPABLE = new Set(['*', '_', '~', '`', '[', '!', '@', '/', '\\', '$']);

// RAW_TEXT 扫描的终止符（行内语法起始符 + HTML 透传检查）
const RAW_TEXT_SPECIALS = new Set([CHAR.STAR, CHAR.UNDERSCORE, CHAR.TILDE, CHAR.BACKTICK,
                                   CHAR.BANG, CHAR.LBRACKET, CHAR.AT, '^', '<', '$']);

class Lexer {
  /**
   * @param {string} source - mslang 格式文本
   */
  constructor(source) {
    // 标准化换行符 (Windows \r\n → \n, 独立 \r → \n)
    this.source = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this._inCodeBlock = false;
  }

  // ================================================================
  // 公共接口
  // ================================================================

  /**
   * 扫描全部源文本，返回 Token 列表
   * @returns {Token[]}
   */
  tokenize() {
    const tokens = [];
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this._inCodeBlock = false;

    while (this.pos < this.source.length) {
      const token = this._nextToken();
      if (token !== null) tokens.push(token);
    }

    // EOF
    tokens.push(new Token(
      TokenType.EOF,
      new Position(this.line, this.col, this.pos),
    ));
    return tokens;
  }

  // ================================================================
  // 主分发
  // ================================================================

  _nextToken() {
    const ch = this._peek();
    if (ch === null) return null;

    // 换行符
    if (ch === CHAR.NEWLINE) return this._scanNewline();

    // 行首判断 — 块级元素
    if (this.col === 1) return this._scanBlockStart();

    // 行内判断
    return this._scanInline();
  }

  // ================================================================
  // 行首块级扫描
  // ================================================================

  _scanBlockStart() {
    const remaining = this.source.slice(this.pos, this._lineEnd());

    // 代码块围栏
    if (remaining.startsWith('```')) return this._scanCodeBlockFence();

    // 代码块内部
    if (this._inCodeBlock) return this._scanCodeBlockLine();

    // 注释行（行首 %，整行丢弃；代码块内由上面分支先行处理）
    if (remaining.startsWith('%')) return this._scanComment();

    // 水平分割线
    let m = remaining.match(RE_HORIZONTAL_RULE);
    if (m) return this._scanHorizontalRule(m);

    // 脚注定义
    m = remaining.match(RE_FOOTNOTE_DEF);
    if (m) return this._scanFootnoteDef(m);

    // 对齐 (在 blockquote 之前检查)
    m = remaining.match(RE_ALIGN_RIGHT);
    if (m) return this._scanAlign(m, TokenType.ALIGN_RIGHT);

    m = remaining.match(RE_ALIGN_CENTER);
    if (m) return this._scanAlign(m, TokenType.ALIGN_CENTER);

    // 标题
    m = remaining.match(RE_HEADING);
    if (m) return this._scanHeading(m);

    // 引用
    m = remaining.match(RE_BLOCKQUOTE);
    if (m) return this._scanBlockquote(m);

    // 无序列表
    m = remaining.match(RE_UNORDERED_LIST);
    if (m) return this._scanUnorderedList(m);

    // 有序列表
    m = remaining.match(RE_ORDERED_LIST);
    if (m) return this._scanOrderedList(m);

    // 表格
    m = remaining.match(RE_TABLE);
    if (m) return this._scanTableRow(m);

    // 图表 caption（{#label} 说明，行首显式声明）
    m = remaining.match(RE_CAPTION);
    if (m) return this._scanCaption(m);

    // 块级公式（$$...$$，可跨行）
    if (remaining.startsWith('$$')) return this._scanMath(false);

    // 默认为行内文本
    return this._scanInline();
  }

  // ================================================================
  // 行内扫描
  // ================================================================

  _scanInline() {
    const ch = this._peek();

    if (ch === '$') return this._scanMath(true);
    if (ch === CHAR.STAR) return this._scanStarDelimited();
    if (ch === CHAR.UNDERSCORE) return this._scanUnderscoreDelimited();
    if (ch === CHAR.TILDE) return this._scanTildeDelimited();
    if (ch === '^') return this._scanSuperscript();
    if (ch === CHAR.BACKTICK) return this._scanInlineCode();

    if (ch === CHAR.BANG) {
      const next = this._peekAt(this.pos + 1);
      if (next === CHAR.LBRACKET) return this._scanImage();
      return this._scanRawText();
    }

    if (ch === CHAR.LBRACKET) {
      if (this._peekAt(this.pos + 1) === '^') return this._scanFootnoteRef();
      return this._scanLink();
    }

    if (ch === CHAR.AT) return this._scanFunctionCall();

    if (ch === CHAR.SLASH) {
      const next = this._peekAt(this.pos + 1);
      if (next === '#') return this._scanColor();
    }

    // HTML 透传 <...>（仅当本行内能找到闭合 >）
    if (ch === '<') {
      const lineEnd = this._lineEnd();
      const gt = this.source.indexOf('>', this.pos + 1);
      if (gt !== -1 && gt < lineEnd) return this._scanHtml(gt);
    }

    return this._scanRawText();
  }

  // ================================================================
  // 扫描方法 — 块级
  // ================================================================

  _scanComment() {
    const lineEnd = this._lineEnd();
    this._advance(lineEnd - this.pos);
    if (this._peek() === CHAR.NEWLINE) this._advance(1);
    return null; // tokenize 循环跳过，注释行透明（不影响块结构）
  }

  _scanHeading(match) {
    const hashes = match[1];
    let content = match[2];
    const level = hashes.length;

    let headingId = '';
    const idM = content.match(/\s*\{#([^}]+)\}\s*$/);
    if (idM) {
      headingId = idM[1];
      content = content.slice(0, idM.index).trimEnd();
    }

    const start = this.pos;
    const totalLen = hashes.length + 1 + match[2].length;
    this._advance(totalLen);

    return new Token(
      TokenType.HEADING,
      new Position(this.line, this.col - totalLen, start),
      content,
      { level, id: headingId }
    );
  }

  _scanHorizontalRule(match) {
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      TokenType.HORIZONTAL_RULE,
      new Position(this.line, this.col - length, start),
      match[0].trim(),
    );
  }

  _scanBlockquote(match) {
    const content = match[1];
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      TokenType.BLOCKQUOTE,
      new Position(this.line, this.col - length, start),
      content,
    );
  }

  _scanUnorderedList(match) {
    const indent = match[1];
    const marker = match[2];
    const content = match[3];
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      TokenType.UNORDERED_LIST,
      new Position(this.line, this.col - length, start),
      content,
      { indent: indent.length, marker }
    );
  }

  _scanOrderedList(match) {
    const indent = match[1];
    const number = match[2];
    const content = match[3];
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      TokenType.ORDERED_LIST,
      new Position(this.line, this.col - length, start),
      content,
      { indent: indent.length, number: parseInt(number, 10) }
    );
  }

  _scanTableRow(match) {
    const inner = match[1].trim();
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);

    const cells = inner.split('|').map(c => c.trim());
    const isSep = cells.every(c => c && /^[-: ]+$/.test(c));

    return new Token(
      isSep ? TokenType.TABLE_SEP : TokenType.TABLE_ROW,
      new Position(this.line, this.col - length, start),
      inner,
      { cells },
    );
  }

  _scanCodeBlockFence() {
    const startPos = new Position(this.line, this.col, this.pos);
    const lineEnd = this._lineEnd();
    const fenceLine = this.source.slice(this.pos, lineEnd);
    this._advance(fenceLine.length);

    if (this._inCodeBlock) {
      this._inCodeBlock = false;
      return new Token(
        TokenType.CODE_BLOCK,
        startPos, '',
        { fence_type: 'end' }
      );
    }
    this._inCodeBlock = true;
    // 起始行：```lang {#label} —— language 与行尾 label 分离
    const rest = fenceLine.slice(3).trim();
    const m = rest.match(/^(\S*)\s*(?:\{#([^}]+)\})?$/);
    const language = m ? m[1] : rest;
    const label = m && m[2] ? m[2] : '';
    return new Token(
      TokenType.CODE_BLOCK,
      startPos, '',
      { fence_type: 'start', language, label }
    );
  }

  _scanCodeBlockLine() {
    const start = this.pos;
    const lineEnd = this._lineEnd();
    const content = this.source.slice(start, lineEnd);
    const pos = new Position(this.line, this.col, start);
    this._advance(content.length);
    return new Token(
      TokenType.RAW_TEXT,
      pos, content,
      { in_code_block: true }
    );
  }

  // ================================================================
  // 扫描方法 — 行内
  // ================================================================

  _scanStarDelimited() {
    const next = this._peekAt(this.pos + 1);
    const next2 = this._peekAt(this.pos + 2);
    if (next === CHAR.STAR && next2 === CHAR.STAR) return this._scanDelimiterWrapped(TokenType.BOLD_ITALIC, '***');
    if (next === CHAR.STAR) return this._scanDelimiterWrapped(TokenType.BOLD, '**');
    return this._scanDelimiterWrapped(TokenType.ITALIC, '*');
  }

  _scanUnderscoreDelimited() {
    const next = this._peekAt(this.pos + 1);
    const next2 = this._peekAt(this.pos + 2);
    if (next === CHAR.UNDERSCORE && next2 === CHAR.UNDERSCORE) return this._scanDelimiterWrapped(TokenType.BOLD_ITALIC, '___');
    if (next === CHAR.UNDERSCORE) return this._scanDelimiterWrapped(TokenType.BOLD, '__');
    return this._scanDelimiterWrapped(TokenType.ITALIC, '_');
  }

  _scanTildeDelimited() {
    const next = this._peekAt(this.pos + 1);
    if (next === CHAR.TILDE) return this._scanDelimiterWrapped(TokenType.STRIKETHROUGH, '~~');
    return this._scanSingleDelimited(TokenType.SUBSCRIPT, '~');
  }

  _scanSuperscript() {
    return this._scanSingleDelimited(TokenType.SUPERSCRIPT, '^');
  }

  _scanSingleDelimited(tokenType, delim) {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(1);
    const endIdx = this.source.indexOf(delim, this.pos);
    if (endIdx === -1 || endIdx === this.pos) {
      return this._fallbackRawText(startPos, delim);
    }
    const inner = this.source.slice(this.pos, endIdx);
    this._advance(inner.length + 1);
    return new Token(tokenType, startPos, inner);
  }

  _scanDelimiterWrapped(tokenType, delimiter) {
    const startPos = new Position(this.line, this.col, this.pos);
    const delLen = delimiter.length;
    this._advance(delLen);

    const endIdx = this.source.indexOf(delimiter, this.pos);
    if (endIdx === -1) {
      return this._fallbackRawText(startPos, delimiter);
    }

    const content = this.source.slice(this.pos, endIdx);
    this._advance(content.length + delLen);

    return new Token(tokenType, startPos, content);
  }

  _scanInlineCode() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(1);
    const endIdx = this.source.indexOf(CHAR.BACKTICK, this.pos);
    if (endIdx === -1) {
      return this._fallbackRawText(startPos, CHAR.BACKTICK);
    }
    const code = this.source.slice(this.pos, endIdx);
    this._advance(code.length + 1);
    return new Token(TokenType.INLINE_CODE, startPos, code);
  }

  _scanFootnoteRef() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(2); // skip [^
    const end = this.source.indexOf(']', this.pos);
    if (end === -1 || end === this.pos) {
      return this._fallbackRawText(startPos, '[^');
    }
    const label = this.source.slice(this.pos, end);
    this._advance(label.length + 1);
    return new Token(TokenType.FOOTNOTE_REF, startPos, label);
  }

  _scanFootnoteDef(match) {
    const label = match[1];
    const content = match[2];
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      TokenType.FOOTNOTE_DEF,
      new Position(this.line, this.col - length, start),
      content,
      { label },
    );
  }

  _scanCaption(match) {
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      TokenType.CAPTION,
      new Position(this.line, this.col - length, start),
      match[2] || '',
      { label: match[1], raw: match[0] },
    );
  }

  /**
   * 扫描公式：$...$（行内，限同行）/ $$...$$（块级，可跨行，行内位置也渲染块级容器）。
   * 未闭合回退普通文本；块级结束分隔符后的同行尾部 {#label} 提取为 label。
   * @param {boolean} limitToLine - 是否限同行搜索（行内触发时为 true）
   */
  _scanMath(limitToLine) {
    const startPos = new Position(this.line, this.col, this.pos);
    const delim = this.source.startsWith('$$', this.pos) ? '$$' : '$';
    const inline = delim === '$';
    const contentStart = this.pos + delim.length;
    const searchEnd = limitToLine ? this._lineEnd() : this.source.length;
    const end = this.source.indexOf(delim, contentStart);
    if (end === -1 || end > searchEnd) {
      this._advance(delim.length); // 推进分隔符，避免 tokenize 死循环
      return this._fallbackRawText(startPos, delim);
    }
    const content = this.source.slice(contentStart, end);
    let label = '';
    let advanceTo = end + delim.length;
    if (!inline) {
      // 结束 $$ 后的同行尾部 {#label}（如 $$ E=mc^2 $$ {#eq:energy}）
      const tailEnd = this.source.indexOf(CHAR.NEWLINE, advanceTo);
      const tail = this.source.slice(advanceTo, tailEnd === -1 ? this.source.length : tailEnd);
      const m = tail.match(/^\s*\{#([^}]+)\}/);
      if (m) {
        label = m[1];
        advanceTo += m[0].length;
      }
    }
    this._advance(advanceTo - this.pos);
    return new Token(TokenType.MATH, startPos, content, { inline, label });
  }

  _scanAlign(match, tokenType) {
    const content = match[1];
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);    return new Token(
      tokenType,
      new Position(this.line, this.col - length, start),
      content,
    );
  }

  _scanLink() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(1); // skip [

    const textEnd = this.source.indexOf(CHAR.RBRACKET, this.pos);
    if (textEnd === -1) return this._fallbackRawText(startPos, '[');

    const text = this.source.slice(this.pos, textEnd);
    this._advance(text.length + 1); // skip text + ]

    if (this._peek() === CHAR.LPAREN) {
      this._advance(1); // skip (
      const urlEnd = this.source.indexOf(CHAR.RPAREN, this.pos);
      if (urlEnd === -1) return this._fallbackRawText(startPos, `[${text}]`);
      const url = this.source.slice(this.pos, urlEnd);
      this._advance(url.length + 1);
      return new Token(TokenType.LINK, startPos, text, { url });
    }

    return this._fallbackRawText(startPos, `[${text}]`);
  }

  _scanImage() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(2); // skip ![

    const altEnd = this.source.indexOf(CHAR.RBRACKET, this.pos);
    if (altEnd === -1) return this._fallbackRawText(startPos, '![');

    const alt = this.source.slice(this.pos, altEnd);
    this._advance(alt.length + 1);

    if (this._peek() === CHAR.LPAREN) {
      this._advance(1);
      const urlEnd = this.source.indexOf(CHAR.RPAREN, this.pos);
      if (urlEnd === -1) return this._fallbackRawText(startPos, `![${alt}]`);
      const urlRaw = this.source.slice(this.pos, urlEnd).trim();
      let url = urlRaw;
      let width = '';
      if (url.includes(' ')) {
        const parts = urlRaw.split(' ');
        const last = parts[parts.length - 1];
        if (last.endsWith('%') && /^\d+%$/.test(last)) {
          url = parts.slice(0, -1).join(' ');
          width = last;
        }
      }
      this._advance(urlRaw.length + 1);

      // 可选的交叉引用标签：![alt](url){#fig:1}
      let label = '';
      if (this.source.startsWith('{#', this.pos)) {
        const labelEnd = this.source.indexOf('}', this.pos);
        if (labelEnd !== -1) {
          label = this.source.slice(this.pos + 2, labelEnd);
          this._advance(labelEnd - this.pos + 1);
        }
      }

      return new Token(TokenType.IMAGE, startPos, alt, { url, width, label });
    }

    return this._fallbackRawText(startPos, `![${alt}]`);
  }

  _scanFunctionCall() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(1); // skip @

    const nameStart = this.pos;
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.source[this.pos])) {
      this._advance(1);
    }

    if (this.pos === nameStart) return this._fallbackRawText(startPos, '@');

    const funcName = this.source.slice(nameStart, this.pos);

    if (this._peek() !== CHAR.LPAREN) {
      return this._fallbackRawText(startPos, `@${funcName}`);
    }

    this._advance(1); // skip (

    // 括号栈匹配（跳过字符串字面量），支持嵌套调用如 @if(@has(x), a, b)
    let depth = 1;
    let rparen = -1;
    let quote = null;
    for (let i = this.pos; i < this.source.length; i++) {
      const ch = this.source[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === CHAR.LPAREN) depth++;
      else if (ch === CHAR.RPAREN) {
        depth--;
        if (depth === 0) { rparen = i; break; }
      }
    }

    if (rparen === -1) return this._fallbackRawText(startPos, `@${funcName}(`);

    const rawArgs = this.source.slice(this.pos, rparen);
    this._advance(rawArgs.length + 1);

    return new Token(TokenType.FUNCTION_CALL, startPos, funcName, {
      raw_args: rawArgs,
    });
  }

  _scanColor() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(2); // skip /#

    const colorStart = this.pos;
    while (this.pos < this.source.length && /[0-9a-fA-F]/.test(this.source[this.pos])) {
      this._advance(1);
    }
    const color = this.source.slice(colorStart, this.pos);
    if (![3, 6].includes(color.length)) {
      return this._fallbackRawText(startPos, `/#${color}`);
    }

    if (this._peek() !== ':') return this._fallbackRawText(startPos, `/#${color}`);
    this._advance(1);

    const endMarker = this.source.indexOf(':/', this.pos);
    if (endMarker === -1) return this._fallbackRawText(startPos, `/#${color}:`);
    const text = this.source.slice(this.pos, endMarker);
    this._advance(text.length + 2);

    return new Token(TokenType.COLOR, startPos, text, { color });
  }

  _scanNewline() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(1); // skip \n

    if (this.col === 1 && this._peek() === CHAR.NEWLINE) {
      this._advance(1);
      return new Token(TokenType.BLANK_LINE, startPos, '\n\n');
    }

    return new Token(TokenType.LINE_BREAK, startPos, '\n');
  }

  _scanHtml(endIdx) {
    const startPos = new Position(this.line, this.col, this.pos);
    const html = this.source.slice(this.pos, endIdx + 1);
    this._advance(html.length);
    return new Token(TokenType.RAW_HTML, startPos, html);
  }

  _scanRawText() {
    const start = this.pos;
    const end = this._lineEnd();

    while (this.pos < end) {
      const ch = this.source[this.pos];
      if (ch === '\\' && this.pos + 1 < this.source.length &&
          ESCAPABLE.has(this.source[this.pos + 1])) {
        this._advance(2);
        continue;
      }
      if (RAW_TEXT_SPECIALS.has(ch)) break;
      // /#hex: 颜色语法 — 仅在匹配时停止，普通 / 继续（如 URL）
      if (ch === '/' && this._isColorStart(this.pos)) break;
      this._advance(1);
    }

    if (this.pos === start) {
      this._advance(1);
      return new Token(
        TokenType.RAW_TEXT,
        new Position(this.line, this.col - 1, start),
        this.source[start],
      );
    }

    // 剥离转义（\X → X），value 为纯文本，不再含行内语法起始符
    const text = this._unescape(this.source.slice(start, this.pos));
    return new Token(
      TokenType.RAW_TEXT,
      new Position(this.line, this.col - (this.pos - start), start),
      text,
    );
  }

  // ================================================================
  // 辅助方法
  // ================================================================

  _peek() {
    if (this.pos >= this.source.length) return null;
    return this.source[this.pos];
  }

  _peekAt(index) {
    if (index >= this.source.length) return null;
    return this.source[index];
  }

  _advance(n = 1) {
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.source.length) return;
      const ch = this.source[this.pos];
      this.pos++;
      if (ch === CHAR.NEWLINE) { this.line++; this.col = 1; }
      else { this.col++; }
    }
  }

  _lineEnd() {
    const end = this.source.indexOf(CHAR.NEWLINE, this.pos);
    return end === -1 ? this.source.length : end;
  }

  _fallbackRawText(startPos, text) {
    return new Token(TokenType.RAW_TEXT, startPos, this._unescape(text));
  }

  /** 剥离转义序列（\\X → X，X 必须属于 ESCAPABLE） */
  _unescape(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
        out += text[i + 1];
        i++;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /**
   * 检查从 pos 开始是否匹配 /#hex: 颜色语法。
   * 仅当完全匹配时才返回 true，避免普通 URL 中的 / 被截断。
   */
  _isColorStart(pos) {
    const src = this.source;
    // 必须是 /# 开头
    if (src[pos] !== '/' || src[pos + 1] !== '#') return false;
    // 后面跟 3 或 6 位 hex 数字
    let j = pos + 2;
    while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
    const hexLen = j - pos - 2;
    if (hexLen !== 3 && hexLen !== 6) return false;
    // hex 之后必须是 ':'
    if (j >= src.length || src[j] !== ':') return false;
    return true;
  }
}

export { Lexer, LexerError };
