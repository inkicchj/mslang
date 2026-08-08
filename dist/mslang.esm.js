/*! mslang v0.1.0 — Lightweight Markup Language | MIT License */
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/tokens.js
var _types = [
  // 块级元素
  "HEADING",
  "HORIZONTAL_RULE",
  "BLOCKQUOTE",
  "CODE_BLOCK",
  "UNORDERED_LIST",
  "ORDERED_LIST",
  // 行内元素
  "BOLD",
  "ITALIC",
  "STRIKETHROUGH",
  "INLINE_CODE",
  "LINK",
  "IMAGE",
  "FUNCTION_CALL",
  "COLOR",
  "SUPERSCRIPT",
  "SUBSCRIPT",
  "RAW_HTML",
  "TABLE_ROW",
  "TABLE_SEP",
  "FOOTNOTE_REF",
  "FOOTNOTE_DEF",
  "ALIGN_RIGHT",
  "ALIGN_CENTER",
  "CAPTION",
  // 文本与空白
  "RAW_TEXT",
  "LINE_BREAK",
  "BLANK_LINE",
  // 特殊
  "EOF"
];
var TokenType = {};
_types.forEach((name, i) => {
  TokenType[name] = { name, value: i + 1 };
});
Object.freeze(TokenType);
var Position = class {
  /** @param {number} line @param {number} col @param {number} index */
  constructor(line, col, index) {
    this.line = line;
    this.col = col;
    this.index = index;
  }
  toString() {
    return `L${this.line}:C${this.col}`;
  }
};
var Token = class {
  /**
   * @param {object} type - TokenType 成员
   * @param {Position} position
   * @param {string} [value]
   * @param {object|null} [metadata]
   */
  constructor(type, position, value = "", metadata = null) {
    this.type = type;
    this.position = position;
    this.value = value;
    this.metadata = metadata;
  }
  toString() {
    const meta = this.metadata ? ` | meta=${JSON.stringify(this.metadata)}` : "";
    return `Token(${this.type.name}, '${this.value.slice(0, 20)}', ${this.position}${meta})`;
  }
};
var CHAR = Object.freeze({
  AT: "@",
  SLASH: "/",
  BACKTICK: "`",
  STAR: "*",
  UNDERSCORE: "_",
  TILDE: "~",
  HASH: "#",
  GT: ">",
  HYPHEN: "-",
  PLUS: "+",
  DOT: ".",
  BANG: "!",
  LBRACKET: "[",
  RBRACKET: "]",
  LPAREN: "(",
  RPAREN: ")",
  PIPE: "|",
  NEWLINE: "\n"
});

// src/lexer.js
var LexerError = class extends Error {
  constructor(message, position) {
    super(`[${position}] ${message}`);
    this.position = position;
  }
};
var RE_HEADING = /^(#{1,6})\s+(.+)$/;
var RE_HORIZONTAL_RULE = /^(\s{0,3})([-*_])\s*\2\s*\2[ \2]*$/;
var RE_BLOCKQUOTE = /^>\s?(.*)$/;
var RE_UNORDERED_LIST = /^(\s*)([-*+])\s+(.+)$/;
var RE_ORDERED_LIST = /^(\s*)(\d+)\.\s+(.+)$/;
var RE_FOOTNOTE_DEF = /^\[\^([^\]]+)\]:\s+(.+)$/;
var RE_TABLE = /^\|(.+)\|$/;
var RE_ALIGN_RIGHT = /^>>\s+(.+)$/;
var RE_ALIGN_CENTER = /^-><-\s+(.+)$/;
var RE_CAPTION = /^\{#([^}]+)\}\s?(.*)$/;
var ESCAPABLE = /* @__PURE__ */ new Set(["*", "_", "~", "`", "[", "!", "@", "/", "\\"]);
var RAW_TEXT_SPECIALS = /* @__PURE__ */ new Set([
  CHAR.STAR,
  CHAR.UNDERSCORE,
  CHAR.TILDE,
  CHAR.BACKTICK,
  CHAR.BANG,
  CHAR.LBRACKET,
  CHAR.AT,
  "^",
  "<"
]);
var Lexer = class {
  /**
   * @param {string} source - mslang 格式文本
   */
  constructor(source) {
    this.source = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
    tokens.push(new Token(
      TokenType.EOF,
      new Position(this.line, this.col, this.pos)
    ));
    return tokens;
  }
  // ================================================================
  // 主分发
  // ================================================================
  _nextToken() {
    const ch = this._peek();
    if (ch === null) return null;
    if (ch === CHAR.NEWLINE) return this._scanNewline();
    if (this.col === 1) return this._scanBlockStart();
    return this._scanInline();
  }
  // ================================================================
  // 行首块级扫描
  // ================================================================
  _scanBlockStart() {
    const remaining = this.source.slice(this.pos, this._lineEnd());
    if (remaining.startsWith("```")) return this._scanCodeBlockFence();
    if (this._inCodeBlock) return this._scanCodeBlockLine();
    let m = remaining.match(RE_HORIZONTAL_RULE);
    if (m) return this._scanHorizontalRule(m);
    m = remaining.match(RE_FOOTNOTE_DEF);
    if (m) return this._scanFootnoteDef(m);
    m = remaining.match(RE_ALIGN_RIGHT);
    if (m) return this._scanAlign(m, TokenType.ALIGN_RIGHT);
    m = remaining.match(RE_ALIGN_CENTER);
    if (m) return this._scanAlign(m, TokenType.ALIGN_CENTER);
    m = remaining.match(RE_HEADING);
    if (m) return this._scanHeading(m);
    m = remaining.match(RE_BLOCKQUOTE);
    if (m) return this._scanBlockquote(m);
    m = remaining.match(RE_UNORDERED_LIST);
    if (m) return this._scanUnorderedList(m);
    m = remaining.match(RE_ORDERED_LIST);
    if (m) return this._scanOrderedList(m);
    m = remaining.match(RE_TABLE);
    if (m) return this._scanTableRow(m);
    m = remaining.match(RE_CAPTION);
    if (m) return this._scanCaption(m);
    return this._scanInline();
  }
  // ================================================================
  // 行内扫描
  // ================================================================
  _scanInline() {
    const ch = this._peek();
    if (ch === CHAR.STAR) return this._scanStarDelimited();
    if (ch === CHAR.UNDERSCORE) return this._scanUnderscoreDelimited();
    if (ch === CHAR.TILDE) return this._scanTildeDelimited();
    if (ch === "^") return this._scanSuperscript();
    if (ch === CHAR.BACKTICK) return this._scanInlineCode();
    if (ch === CHAR.BANG) {
      const next = this._peekAt(this.pos + 1);
      if (next === CHAR.LBRACKET) return this._scanImage();
      return this._scanRawText();
    }
    if (ch === CHAR.LBRACKET) {
      if (this._peekAt(this.pos + 1) === "^") return this._scanFootnoteRef();
      return this._scanLink();
    }
    if (ch === CHAR.AT) return this._scanFunctionCall();
    if (ch === CHAR.SLASH) {
      const next = this._peekAt(this.pos + 1);
      if (next === "#") return this._scanColor();
    }
    if (ch === "<") {
      const lineEnd = this._lineEnd();
      const gt = this.source.indexOf(">", this.pos + 1);
      if (gt !== -1 && gt < lineEnd) return this._scanHtml(gt);
    }
    return this._scanRawText();
  }
  // ================================================================
  // 扫描方法 — 块级
  // ================================================================
  _scanHeading(match) {
    const hashes = match[1];
    let content = match[2];
    const level = hashes.length;
    let headingId = "";
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
      match[0].trim()
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
      content
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
    const cells = inner.split("|").map((c) => c.trim());
    const isSep = cells.every((c) => c && /^[-: ]+$/.test(c));
    return new Token(
      isSep ? TokenType.TABLE_SEP : TokenType.TABLE_ROW,
      new Position(this.line, this.col - length, start),
      inner,
      { cells }
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
        startPos,
        "",
        { fence_type: "end" }
      );
    }
    this._inCodeBlock = true;
    const language = fenceLine.slice(3).trim();
    return new Token(
      TokenType.CODE_BLOCK,
      startPos,
      "",
      { fence_type: "start", language }
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
      pos,
      content,
      { in_code_block: true }
    );
  }
  // ================================================================
  // 扫描方法 — 行内
  // ================================================================
  _scanStarDelimited() {
    const next = this._peekAt(this.pos + 1);
    if (next === CHAR.STAR) return this._scanDelimiterWrapped(TokenType.BOLD, "**");
    return this._scanDelimiterWrapped(TokenType.ITALIC, "*");
  }
  _scanUnderscoreDelimited() {
    const next = this._peekAt(this.pos + 1);
    if (next === CHAR.UNDERSCORE) return this._scanDelimiterWrapped(TokenType.BOLD, "__");
    return this._scanDelimiterWrapped(TokenType.ITALIC, "_");
  }
  _scanTildeDelimited() {
    const next = this._peekAt(this.pos + 1);
    if (next === CHAR.TILDE) return this._scanDelimiterWrapped(TokenType.STRIKETHROUGH, "~~");
    return this._scanSingleDelimited(TokenType.SUBSCRIPT, "~");
  }
  _scanSuperscript() {
    return this._scanSingleDelimited(TokenType.SUPERSCRIPT, "^");
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
    this._advance(2);
    const end = this.source.indexOf("]", this.pos);
    if (end === -1 || end === this.pos) {
      return this._fallbackRawText(startPos, "[^");
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
      { label }
    );
  }
  _scanCaption(match) {
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      TokenType.CAPTION,
      new Position(this.line, this.col - length, start),
      match[2] || "",
      { label: match[1], raw: match[0] }
    );
  }
  _scanAlign(match, tokenType) {
    const content = match[1];
    const length = match[0].length;
    const start = this.pos;
    this._advance(length);
    return new Token(
      tokenType,
      new Position(this.line, this.col - length, start),
      content
    );
  }
  _scanLink() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(1);
    const textEnd = this.source.indexOf(CHAR.RBRACKET, this.pos);
    if (textEnd === -1) return this._fallbackRawText(startPos, "[");
    const text = this.source.slice(this.pos, textEnd);
    this._advance(text.length + 1);
    if (this._peek() === CHAR.LPAREN) {
      this._advance(1);
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
    this._advance(2);
    const altEnd = this.source.indexOf(CHAR.RBRACKET, this.pos);
    if (altEnd === -1) return this._fallbackRawText(startPos, "![");
    const alt = this.source.slice(this.pos, altEnd);
    this._advance(alt.length + 1);
    if (this._peek() === CHAR.LPAREN) {
      this._advance(1);
      const urlEnd = this.source.indexOf(CHAR.RPAREN, this.pos);
      if (urlEnd === -1) return this._fallbackRawText(startPos, `![${alt}]`);
      const urlRaw = this.source.slice(this.pos, urlEnd).trim();
      let url = urlRaw;
      let width = "";
      if (url.includes(" ")) {
        const parts = urlRaw.split(" ");
        const last = parts[parts.length - 1];
        if (last.endsWith("%") && /^\d+%$/.test(last)) {
          url = parts.slice(0, -1).join(" ");
          width = last;
        }
      }
      this._advance(urlRaw.length + 1);
      let label = "";
      if (this.source.startsWith("{#", this.pos)) {
        const labelEnd = this.source.indexOf("}", this.pos);
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
    this._advance(1);
    const nameStart = this.pos;
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.source[this.pos])) {
      this._advance(1);
    }
    if (this.pos === nameStart) return this._fallbackRawText(startPos, "@");
    const funcName = this.source.slice(nameStart, this.pos);
    if (this._peek() !== CHAR.LPAREN) {
      return this._fallbackRawText(startPos, `@${funcName}`);
    }
    this._advance(1);
    let depth = 1;
    let rparen = -1;
    let quote = null;
    for (let i = this.pos; i < this.source.length; i++) {
      const ch = this.source[i];
      if (quote) {
        if (ch === "\\") {
          i++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === CHAR.LPAREN) depth++;
      else if (ch === CHAR.RPAREN) {
        depth--;
        if (depth === 0) {
          rparen = i;
          break;
        }
      }
    }
    if (rparen === -1) return this._fallbackRawText(startPos, `@${funcName}(`);
    const rawArgs = this.source.slice(this.pos, rparen);
    this._advance(rawArgs.length + 1);
    return new Token(TokenType.FUNCTION_CALL, startPos, funcName, {
      raw_args: rawArgs
    });
  }
  _scanColor() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(2);
    const colorStart = this.pos;
    while (this.pos < this.source.length && /[0-9a-fA-F]/.test(this.source[this.pos])) {
      this._advance(1);
    }
    const color = this.source.slice(colorStart, this.pos);
    if (![3, 6].includes(color.length)) {
      return this._fallbackRawText(startPos, `/#${color}`);
    }
    if (this._peek() !== ":") return this._fallbackRawText(startPos, `/#${color}`);
    this._advance(1);
    const endMarker = this.source.indexOf(":/", this.pos);
    if (endMarker === -1) return this._fallbackRawText(startPos, `/#${color}:`);
    const text = this.source.slice(this.pos, endMarker);
    this._advance(text.length + 2);
    return new Token(TokenType.COLOR, startPos, text, { color });
  }
  _scanNewline() {
    const startPos = new Position(this.line, this.col, this.pos);
    this._advance(1);
    if (this.col === 1 && this._peek() === CHAR.NEWLINE) {
      this._advance(1);
      return new Token(TokenType.BLANK_LINE, startPos, "\n\n");
    }
    return new Token(TokenType.LINE_BREAK, startPos, "\n");
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
      if (ch === "\\" && this.pos + 1 < this.source.length && ESCAPABLE.has(this.source[this.pos + 1])) {
        this._advance(2);
        continue;
      }
      if (RAW_TEXT_SPECIALS.has(ch)) break;
      if (ch === "/" && this._isColorStart(this.pos)) break;
      this._advance(1);
    }
    if (this.pos === start) {
      this._advance(1);
      return new Token(
        TokenType.RAW_TEXT,
        new Position(this.line, this.col - 1, start),
        this.source[start]
      );
    }
    const text = this._unescape(this.source.slice(start, this.pos));
    return new Token(
      TokenType.RAW_TEXT,
      new Position(this.line, this.col - (this.pos - start), start),
      text
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
      if (ch === CHAR.NEWLINE) {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
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
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
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
    if (src[pos] !== "/" || src[pos + 1] !== "#") return false;
    let j = pos + 2;
    while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
    const hexLen = j - pos - 2;
    if (hexLen !== 3 && hexLen !== 6) return false;
    if (j >= src.length || src[j] !== ":") return false;
    return true;
  }
  // ================================================================
  // 调试工具
  // ================================================================
  /** @param {Token[]} tokens */
  dumpTokens(tokens) {
    const lines = [
      "=".repeat(60),
      `Token Stream (${tokens.length} tokens)`,
      "=".repeat(60)
    ];
    tokens.forEach((t, i) => {
      const metaStr = t.metadata ? ` meta=${JSON.stringify(t.metadata)}` : "";
      lines.push(
        `  [${String(i).padStart(3, "0")}] ${t.type.name.padEnd(18)} @ ${String(t.position).padStart(10)}  value='${t.value.slice(0, 40)}'${metaStr}`
      );
    });
    return lines.join("\n");
  }
};

// src/expression.js
var EvalError = class extends Error {
  constructor(message) {
    super(`EvalError: ${message}`);
  }
};
var ExpressionParser = class {
  /** @param {string} source */
  constructor(source) {
    this.source = source;
    this.pos = 0;
  }
  // ---- 工具 ----
  _skipWs() {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) this.pos++;
  }
  _peek() {
    return this.pos < this.source.length ? this.source[this.pos] : null;
  }
  _error(message) {
    throw new Error(`\u8868\u8FBE\u5F0F\u8BED\u6CD5\u9519\u8BEF @${this.pos}: ${message}`);
  }
  _readIdentifier() {
    const m = /^[a-zA-Z0-9_]+/.exec(this.source.slice(this.pos));
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }
  // ---- 入口 ----
  /** 解析单个表达式 */
  parse() {
    this._skipWs();
    const node = this._parseOr();
    this._skipWs();
    if (this.pos < this.source.length) this._error(`\u610F\u5916\u7684\u5B57\u7B26 '${this.source[this.pos]}'`);
    return node;
  }
  /** 解析参数列表，返回 { args: node[], kwargs: Object<string, node> } */
  parseArgs() {
    this._skipWs();
    return this._parseArgsBody();
  }
  // ---- 参数 ----
  _parseArgsBody() {
    const args = [];
    const kwargs = {};
    while (true) {
      this._skipWs();
      if (this._peek() === null || this._peek() === ")") break;
      const arg = this._parseArg();
      if (arg.kw) kwargs[arg.kw] = arg.node;
      else args.push(arg.node);
      this._skipWs();
      if (this._peek() === ",") {
        this.pos++;
        continue;
      }
      break;
    }
    return { args, kwargs };
  }
  _parseArg() {
    const save = this.pos;
    const name = this._readIdentifier();
    if (name !== null) {
      this._skipWs();
      if (this._peek() === "=" && this.source[this.pos + 1] !== "=") {
        this.pos++;
        this._skipWs();
        return { kw: name, node: this._parseOr() };
      }
    }
    this.pos = save;
    return { node: this._parseOr() };
  }
  // ---- 优先级链 ----
  _parseOr() {
    let left = this._parseAnd();
    while (true) {
      this._skipWs();
      if (this._peek() !== "|" || this.source[this.pos + 1] !== "|") break;
      this.pos += 2;
      this._skipWs();
      left = { type: "binary", op: "||", left, right: this._parseAnd() };
    }
    return left;
  }
  _parseAnd() {
    let left = this._parseCmp();
    while (true) {
      this._skipWs();
      if (this._peek() !== "&" || this.source[this.pos + 1] !== "&") break;
      this.pos += 2;
      this._skipWs();
      left = { type: "binary", op: "&&", left, right: this._parseCmp() };
    }
    return left;
  }
  _parseCmp() {
    let left = this._parseAdd();
    while (true) {
      this._skipWs();
      let op = null;
      for (const candidate of ["==", "!=", "<=", ">=", "<", ">"]) {
        if (this.source.startsWith(candidate, this.pos)) {
          op = candidate;
          break;
        }
      }
      if (!op) break;
      this.pos += op.length;
      this._skipWs();
      left = { type: "binary", op, left, right: this._parseAdd() };
    }
    return left;
  }
  _parseAdd() {
    let left = this._parseMul();
    while (true) {
      this._skipWs();
      const ch = this._peek();
      if (ch !== "+" && ch !== "-") break;
      this.pos++;
      this._skipWs();
      left = { type: "binary", op: ch, left, right: this._parseMul() };
    }
    return left;
  }
  _parseMul() {
    let left = this._parseUnary();
    while (true) {
      this._skipWs();
      const ch = this._peek();
      if (ch !== "*" && ch !== "/" && ch !== "%") break;
      this.pos++;
      this._skipWs();
      left = { type: "binary", op: ch, left, right: this._parseUnary() };
    }
    return left;
  }
  _parseUnary() {
    this._skipWs();
    const ch = this._peek();
    if (ch === "!" || ch === "-") {
      this.pos++;
      this._skipWs();
      return { type: "unary", op: ch, operand: this._parseUnary() };
    }
    return this._parsePrimary();
  }
  // ---- 基本项 ----
  _parsePrimary() {
    this._skipWs();
    const ch = this._peek();
    if (ch === null) this._error("\u8868\u8FBE\u5F0F\u610F\u5916\u7ED3\u675F");
    if (ch === "(") {
      this.pos++;
      const node = this._parseOr();
      this._skipWs();
      if (this._peek() !== ")") this._error("\u7F3A\u5C11 ')'");
      this.pos++;
      return node;
    }
    if (ch === "{") return this._parseObject();
    if (ch === "[") return this._parseArray();
    if (ch === '"' || ch === "'") return this._parseString(ch);
    if (ch >= "0" && ch <= "9") return this._parseNumber();
    const name = this._readIdentifier();
    if (name !== null) {
      if (name === "true") return { type: "bool", value: true };
      if (name === "false") return { type: "bool", value: false };
      if (name === "null") return { type: "null" };
      this._skipWs();
      if (this._peek() === "(") {
        this.pos++;
        const { args, kwargs } = this._parseArgsBody();
        this._skipWs();
        if (this._peek() !== ")") this._error("\u7F3A\u5C11 ')'");
        this.pos++;
        return { type: "call", name, args, kwargs };
      }
      return { type: "var", name };
    }
    this._error(`\u610F\u5916\u7684\u5B57\u7B26 '${ch}'`);
  }
  /** 数组字面量：[expr, expr, ...] */
  _parseArray() {
    this.pos++;
    const items = [];
    while (true) {
      this._skipWs();
      if (this._peek() === "]") {
        this.pos++;
        return { type: "array", items };
      }
      items.push(this._parseOr());
      this._skipWs();
      const c = this._peek();
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return { type: "array", items };
      }
      this._error("\u6570\u7EC4\u5B57\u9762\u91CF\u7F3A\u5C11 ']'");
    }
  }
  /** 对象字面量：{ key: expr, ... }，键为任意字符（冒号前），支持中文 */
  _parseObject() {
    this.pos++;
    const obj = {};
    while (true) {
      this._skipWs();
      if (this._peek() === "}") {
        this.pos++;
        return { type: "object", value: obj };
      }
      let key = "";
      while (this.pos < this.source.length && this.source[this.pos] !== ":") {
        key += this.source[this.pos];
        this.pos++;
      }
      key = key.trim();
      if (!key) this._error("\u5BF9\u8C61\u952E\u4E0D\u80FD\u4E3A\u7A7A");
      this.pos++;
      this._skipWs();
      obj[key] = this._parseOr();
      this._skipWs();
      const c = this._peek();
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return { type: "object", value: obj };
      }
      this._error("\u5BF9\u8C61\u5B57\u9762\u91CF\u7F3A\u5C11 '}'");
    }
  }
  _parseString(quote) {
    this.pos++;
    let out = "";
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if (ch === "\\") {
        this.pos++;
        if (this.pos >= this.source.length) this._error("\u5B57\u7B26\u4E32\u8F6C\u4E49\u4E0D\u5B8C\u6574");
        out += this.source[this.pos];
        this.pos++;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        return { type: "string", value: out };
      }
      out += ch;
      this.pos++;
    }
    this._error("\u5B57\u7B26\u4E32\u672A\u95ED\u5408");
  }
  _parseNumber() {
    let j = this.pos;
    while (j < this.source.length && /[0-9]/.test(this.source[j])) j++;
    if (this.source[j] === "." && /[0-9]/.test(this.source[j + 1] || "")) {
      j++;
      while (j < this.source.length && /[0-9]/.test(this.source[j])) j++;
    }
    const value = Number(this.source.slice(this.pos, j));
    this.pos = j;
    return { type: "number", value };
  }
};
function evaluate(node, ctx = {}) {
  const functions = ctx.functions || {};
  const variables = ctx.variables || {};
  switch (node.type) {
    case "number":
    case "string":
    case "bool":
      return node.value;
    case "null":
      return null;
    case "object": {
      const obj = {};
      for (const [k, v] of Object.entries(node.value)) obj[k] = evaluate(v, ctx);
      return obj;
    }
    case "array":
      return node.items.map((item) => evaluate(item, ctx));
    case "var": {
      if (!(node.name in variables)) {
        throw new EvalError(`\u672A\u5B9A\u4E49\u7684\u53D8\u91CF '${node.name}'`);
      }
      return variables[node.name];
    }
    case "call": {
      const func = functions[node.name];
      if (typeof func !== "function") {
        throw new EvalError(`\u672A\u5B9A\u4E49\u7684\u51FD\u6570 '${node.name}'`);
      }
      const args = node.args.map((a) => evaluate(a, ctx));
      const kwargs = {};
      for (const [k, v] of Object.entries(node.kwargs)) kwargs[k] = evaluate(v, ctx);
      return func(...args, kwargs);
    }
    case "unary": {
      const v = evaluate(node.operand, ctx);
      return node.op === "!" ? !v : -v;
    }
    case "binary": {
      const left = evaluate(node.left, ctx);
      if (node.op === "&&") return left ? evaluate(node.right, ctx) : left;
      if (node.op === "||") return left ? left : evaluate(node.right, ctx);
      const right = evaluate(node.right, ctx);
      switch (node.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "%":
          return left % right;
      }
      throw new EvalError(`\u672A\u77E5\u8FD0\u7B97\u7B26 '${node.op}'`);
    }
    default:
      throw new EvalError(`\u672A\u77E5\u8868\u8FBE\u5F0F\u8282\u70B9 '${node.type}'`);
  }
}
function parseExpression(source) {
  return new ExpressionParser(source).parse();
}
function parseArgs(raw) {
  return new ExpressionParser(raw).parseArgs();
}

// src/nodes.js
var ASTNode = class {
  /** @param {NodeVisitor} visitor */
  accept(visitor) {
    throw new Error(`accept() not implemented for ${this.constructor.name}`);
  }
};
var Document = class extends ASTNode {
  /**
   * @param {BlockNode[]} [blocks]
   * @param {Object<string, string>} [footnotes] - {label: definition_text}
   */
  constructor(blocks = [], footnotes = {}) {
    super();
    this.blocks = blocks;
    this.footnotes = footnotes;
  }
  accept(visitor) {
    return visitor.visit_Document(this);
  }
};
var BlockNode = class extends ASTNode {
};
var Heading = class extends BlockNode {
  /**
   * @param {number} level
   * @param {InlineNode[]} [content]
   * @param {string} [id]
   */
  constructor(level, content = [], id = "") {
    super();
    this.level = level;
    this.content = content;
    this.id = id;
  }
  accept(visitor) {
    return visitor.visit_Heading(this);
  }
};
var Paragraph = class extends BlockNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_Paragraph(this);
  }
};
var BlockQuote = class extends BlockNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_BlockQuote(this);
  }
};
var CodeBlock = class extends BlockNode {
  /**
   * @param {string} [language]
   * @param {string} [code]
   */
  constructor(language = "", code = "") {
    super();
    this.language = language;
    this.code = code;
  }
  accept(visitor) {
    return visitor.visit_CodeBlock(this);
  }
};
var UnorderedList = class extends BlockNode {
  /** @param {ListItem[]} [items] */
  constructor(items = []) {
    super();
    this.items = items;
  }
  accept(visitor) {
    return visitor.visit_UnorderedList(this);
  }
};
var OrderedList = class extends BlockNode {
  /** @param {ListItem[]} [items] */
  constructor(items = []) {
    super();
    this.items = items;
  }
  accept(visitor) {
    return visitor.visit_OrderedList(this);
  }
};
var ListItem = class extends ASTNode {
  /**
   * @param {InlineNode[]} [content]
   * @param {BlockNode[]} [children]
   * @param {boolean|null} [checked] - null=普通, true=已勾选, false=未勾选
   */
  constructor(content = [], children = [], checked = null) {
    super();
    this.content = content;
    this.children = children;
    this.checked = checked;
  }
  accept(visitor) {
    return visitor.visit_ListItem(this);
  }
};
var HorizontalRule = class extends BlockNode {
  accept(visitor) {
    return visitor.visit_HorizontalRule(this);
  }
};
var AlignBlock = class extends BlockNode {
  /**
   * @param {string} [align] - 'left' | 'center' | 'right'
   * @param {InlineNode[]} [content]
   */
  constructor(align = "left", content = []) {
    super();
    this.align = align;
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_AlignBlock(this);
  }
};
var Caption = class extends BlockNode {
  constructor(label = "", content = [], raw = "") {
    super();
    this.label = label;
    this.content = content;
    this.raw = raw;
  }
  accept(visitor) {
    return visitor.visit_Caption(this);
  }
};
var Table = class extends BlockNode {
  /**
   * @param {string[]} [headers]
   * @param {string[][]} [rows]
   * @param {string} [label] - 交叉引用标签，如 "tbl:1"
   */
  constructor(headers = [], rows = [], label = "") {
    super();
    this.headers = headers;
    this.rows = rows;
    this.label = label;
    this.caption = [];
  }
  accept(visitor) {
    return visitor.visit_Table(this);
  }
};
var InlineNode = class extends ASTNode {
};
var RawText = class extends InlineNode {
  /** @param {string} [text] */
  constructor(text = "") {
    super();
    this.text = text;
  }
  accept(visitor) {
    return visitor.visit_RawText(this);
  }
};
var Bold = class extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_Bold(this);
  }
};
var Italic = class extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_Italic(this);
  }
};
var Strikethrough = class extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_Strikethrough(this);
  }
};
var InlineCode = class extends InlineNode {
  /** @param {string} [code] */
  constructor(code = "") {
    super();
    this.code = code;
  }
  accept(visitor) {
    return visitor.visit_InlineCode(this);
  }
};
var Link = class extends InlineNode {
  /**
   * @param {string} [text]
   * @param {string} [url]
   */
  constructor(text = "", url = "") {
    super();
    this.text = text;
    this.url = url;
  }
  accept(visitor) {
    return visitor.visit_Link(this);
  }
};
var Image = class extends InlineNode {
  /**
   * @param {string} [alt]
   * @param {string} [url]
   * @param {string} [width] - 如 "80%"
   * @param {string} [label] - 交叉引用标签，如 "fig:1"
   */
  constructor(alt = "", url = "", width = "", label = "") {
    super();
    this.alt = alt;
    this.url = url;
    this.width = width;
    this.label = label;
    this.caption = [];
  }
  accept(visitor) {
    return visitor.visit_Image(this);
  }
};
var FunctionCall = class extends InlineNode {
  /**
   * @param {string} [name]
   * @param {object[]} [args] - 表达式 AST 列表
   * @param {Object<string, object>} [kwargs] - 关键字参数（表达式 AST）
   * @param {string} [rawArgs]
   * @param {string} [error] - 参数表达式解析错误信息（空串表示无错误）
   */
  constructor(name = "", args = [], kwargs = {}, rawArgs = "", error = "") {
    super();
    this.name = name;
    this.args = args;
    this.kwargs = kwargs;
    this.rawArgs = rawArgs;
    this.error = error;
  }
  accept(visitor) {
    return visitor.visit_FunctionCall(this);
  }
};
var Color = class extends InlineNode {
  /**
   * @param {string} [color] - hex
   * @param {string} [text]
   */
  constructor(color = "", text = "") {
    super();
    this.color = color;
    this.text = text;
  }
  accept(visitor) {
    return visitor.visit_Color(this);
  }
};
var Superscript = class extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_Superscript(this);
  }
};
var Subscript = class extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }
  accept(visitor) {
    return visitor.visit_Subscript(this);
  }
};
var RawHtml = class extends InlineNode {
  /** @param {string} [html] */
  constructor(html = "") {
    super();
    this.html = html;
  }
  accept(visitor) {
    return visitor.visit_RawHtml(this);
  }
};
var FootnoteRef = class extends InlineNode {
  /**
   * @param {string} [label]
   * @param {number} [number]
   */
  constructor(label = "", number = 0) {
    super();
    this.label = label;
    this.number = number;
  }
  accept(visitor) {
    return visitor.visit_FootnoteRef(this);
  }
};
var LineBreak = class extends InlineNode {
  accept(visitor) {
    return visitor.visit_LineBreak(this);
  }
};

// src/parser.js
var BLOCK_BOUNDARY_TYPES = /* @__PURE__ */ new Set([
  TokenType.HEADING,
  TokenType.HORIZONTAL_RULE,
  TokenType.BLOCKQUOTE,
  TokenType.UNORDERED_LIST,
  TokenType.ORDERED_LIST,
  TokenType.TABLE_ROW,
  TokenType.TABLE_SEP,
  TokenType.ALIGN_RIGHT,
  TokenType.ALIGN_CENTER,
  TokenType.BLANK_LINE,
  TokenType.EOF
]);
var ParserError = class extends Error {
  constructor(message, token = null) {
    const loc = token ? ` [${token.position}]` : "";
    super(`ParseError${loc}: ${message}`);
    this.token = token;
  }
};
var URL_RE = /^(https?:\/\/[^\s<>"{}|\\^`]+)$/;
var URL_FIND_RE = /https?:\/\/[^\s<>"{}|\\^`]+/g;
var Parser = class {
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
      if (block === null) continue;
      if (block instanceof Caption) {
        const target = this._captionTarget(document.blocks[document.blocks.length - 1], block.label);
        if (target) {
          target.caption = block.content;
          continue;
        }
        const prefix = `{#${block.label}}`;
        const rest = block.raw.startsWith(prefix) ? block.raw.slice(prefix.length) : block.raw;
        const inlines = [new RawText(prefix), ...this._parseInline(rest)];
        document.blocks.push(new Paragraph(this._mergeAdjacentText(inlines)));
        continue;
      }
      document.blocks.push(block);
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
    if (token.type === TokenType.LINE_BREAK) {
      this._advance();
      return null;
    }
    if (token.type === TokenType.BLANK_LINE) {
      this._advance();
      let extraBlanks = 0;
      while (this._current() && this._current().type === TokenType.BLANK_LINE) {
        this._advance();
        extraBlanks++;
      }
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
    if (token.type === TokenType.HEADING) return this._parseHeading();
    if (token.type === TokenType.HORIZONTAL_RULE) {
      this._advance();
      return new HorizontalRule();
    }
    if (token.type === TokenType.BLOCKQUOTE) return this._parseBlockquote();
    if (token.type === TokenType.CODE_BLOCK && token.metadata && token.metadata.fence_type === "start") {
      return this._parseCodeBlock();
    }
    if (token.type === TokenType.UNORDERED_LIST) return this._parseUnorderedList();
    if (token.type === TokenType.ORDERED_LIST) return this._parseOrderedList();
    if (token.type === TokenType.TABLE_ROW) return this._parseTable();
    if (token.type === TokenType.FOOTNOTE_DEF) return this._parseFootnoteDef();
    if (token.type === TokenType.ALIGN_RIGHT || token.type === TokenType.ALIGN_CENTER) {
      return this._parseAlign(token);
    }
    if (token.type === TokenType.CAPTION) return this._parseCaption(token);
    if (token.type === TokenType.RAW_TEXT || token.type.value >= TokenType.BOLD.value) {
      return this._parseParagraph();
    }
    this._advance();
    return null;
  }
  _parseHeading() {
    const token = this._advance();
    const level = token.metadata.level || 1;
    const headingId = token.metadata.id || "";
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
    if (!seenText) return new Paragraph([new RawText("")]);
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
    const language = startToken.metadata.language || "";
    const codeLines = [];
    while (!this._isAtEnd()) {
      const token = this._current();
      if (token.type === TokenType.CODE_BLOCK && token.metadata && token.metadata.fence_type === "end") {
        this._advance();
        break;
      }
      if (token.type === TokenType.RAW_TEXT && token.metadata && token.metadata.in_code_block) {
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
    while (codeLines.length && codeLines[0] === "") codeLines.shift();
    while (codeLines.length && codeLines[codeLines.length - 1] === "") codeLines.pop();
    return new CodeBlock(language, codeLines.join("\n"));
  }
  _parseUnorderedList() {
    return new UnorderedList(this._parseListItems(TokenType.UNORDERED_LIST));
  }
  _parseOrderedList() {
    return new OrderedList(this._parseListItems(TokenType.ORDERED_LIST));
  }
  _parseListItems(listType) {
    const items = [];
    while (this._current() && this._current().type === TokenType.LINE_BREAK) {
      this._advance();
    }
    const firstToken = this._current();
    const baseIndent = firstToken && firstToken.metadata ? firstToken.metadata.indent || 0 : 0;
    while (!this._isAtEnd()) {
      const token = this._current();
      if (token.type === listType) {
        const tokenIndent = token.metadata.indent || 0;
        if (tokenIndent < baseIndent) break;
        this._advance();
        const inlines = this._parseInline(token.value);
        const item = new ListItem(this._mergeAdjacentText(inlines));
        if (item.content.length && item.content[0] instanceof RawText) {
          const t = item.content[0].text;
          if (t.startsWith("[ ] ")) {
            item.checked = false;
            item.content[0] = new RawText(t.slice(4));
          } else if (t.startsWith("[x] ") || t.startsWith("[X] ")) {
            item.checked = true;
            item.content[0] = new RawText(t.slice(4));
          }
        }
        const nt = this._peekPastBreaks();
        if (nt && (nt.type === TokenType.UNORDERED_LIST || nt.type === TokenType.ORDERED_LIST)) {
          const nextIndent = nt.metadata ? nt.metadata.indent || 0 : 0;
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
    let label = "";
    while (!this._isAtEnd()) {
      const token = this._current();
      if (token.type !== TokenType.TABLE_ROW && token.type !== TokenType.TABLE_SEP) break;
      let cells = token.metadata ? token.metadata.cells || [] : [];
      this._advance();
      if (token.type === TokenType.TABLE_SEP) {
        hasSep = true;
        if (this._current() && this._current().type === TokenType.LINE_BREAK) this._advance();
        continue;
      }
      if (!hasSep) {
        if (headers.length === 0) {
          const last = cells.length ? cells[cells.length - 1] : "";
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
    if (prev instanceof Paragraph && prev.content.length === 1 && prev.content[0] instanceof Image && prev.content[0].label === label) {
      return prev.content[0];
    }
    return null;
  }
  _parseCaption(token) {
    this._advance();
    const label = token.metadata.label || "";
    const content = this._mergeAdjacentText(this._parseInline(token.value));
    return new Caption(label, content, token.metadata.raw || "");
  }
  _parseFootnoteDef() {
    const token = this._advance();
    const label = token.metadata.label || "";
    this._footnoteDefs[label] = token.value;
    return null;
  }
  _parseAlign(token) {
    this._advance();
    const align = token.type === TokenType.ALIGN_RIGHT ? "right" : "center";
    const inlines = this._parseInline(token.value);
    return new AlignBlock(align, this._mergeAdjacentText(inlines));
  }
  _parseInlineToken(token) {
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
      return new Link(token.value, token.metadata.url || "");
    }
    if (token.type === TokenType.IMAGE) {
      return new Image(
        token.value,
        token.metadata.url || "",
        token.metadata.width || "",
        token.metadata.label || ""
      );
    }
    if (token.type === TokenType.FUNCTION_CALL) {
      const rawArgs = token.metadata.raw_args || "";
      let args = [];
      let kwargs = {};
      let error = "";
      try {
        ({ args, kwargs } = parseArgs(rawArgs));
      } catch (e) {
        error = e.message;
      }
      return new FunctionCall(token.value, args, kwargs, rawArgs, error);
    }
    if (token.type === TokenType.COLOR) {
      return new Color(token.metadata.color || "", token.value);
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
      if (token.type === TokenType.RAW_TEXT || token.type === TokenType.LINE_BREAK || token.type === TokenType.BLANK_LINE) {
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
      if (URL_RE.test(text)) {
        result.push(new Link(text, text));
        continue;
      }
      URL_FIND_RE.lastIndex = 0;
      let lastIndex = 0;
      let match;
      let found = false;
      while ((match = URL_FIND_RE.exec(text)) !== null) {
        found = true;
        if (match.index > lastIndex) {
          result.push(new RawText(text.slice(lastIndex, match.index)));
        }
        result.push(new Link(match[0], match[0]));
        lastIndex = URL_FIND_RE.lastIndex;
      }
      if (!found) {
        result.push(node);
      } else if (lastIndex < text.length) {
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
    return token.type === TokenType.CODE_BLOCK && token.metadata && ["start", "end"].includes(token.metadata.fence_type);
  }
  // ================================================================
  // 调试 — AST 打印
  // ================================================================
  /** 委托给模块级 dumpAST（下方定义，供调试打印 AST） */
  dumpAST(node) {
    return dumpAST(node);
  }
};
function _isSpacer(node) {
  return node instanceof Paragraph && node.content.length > 0 && node.content.every((n) => n instanceof LineBreak);
}
function _walkNodes(node, fn) {
  fn(node);
  for (const attr of ["content", "children", "blocks", "items"]) {
    const children = node[attr];
    if (Array.isArray(children)) {
      for (const child of children) _walkNodes(child, fn);
    }
  }
}
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
      if (node instanceof FootnoteRef && footnotes[node.label] !== void 0) {
        counter++;
        node.number = counter;
        ordered[node.label] = footnotes[node.label];
      }
    });
  }
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
function dumpAST(node, indent = 0, prefix = "", isLast = true) {
  const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
  const continuation = isLast ? "    " : "\u2502   ";
  const linePrefix = indent === 0 ? "" : prefix + connector;
  const name = node.constructor.name;
  if (node instanceof Document) {
    const lines = ["Document"];
    node.blocks.forEach((block, i) => {
      const last = i === node.blocks.length - 1;
      lines.push(dumpAST(block, indent + 1, "", last));
    });
    return lines.join("\n");
  }
  if (node instanceof Heading) {
    const lines = [`${linePrefix}Heading (level=${node.level})`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof Paragraph) {
    if (_isSpacer(node)) return `${linePrefix}Spacer (x${node.content.length} <br>)`;
    const lines = [`${linePrefix}Paragraph`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof BlockQuote) {
    const lines = [`${linePrefix}BlockQuote`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof CodeBlock) {
    const lines = [`${linePrefix}CodeBlock (lang=${JSON.stringify(node.language)})`];
    const codePreview = node.code.trim();
    codePreview.split("\n").forEach((cl) => {
      lines.push(`${continuation}\u2502   ${cl}`);
    });
    return lines.join("\n");
  }
  if (node instanceof UnorderedList) {
    const lines = [`${linePrefix}UnorderedList`];
    node.items.forEach((item, i) => {
      const last = i === node.items.length - 1;
      lines.push(dumpAST(item, indent + 1, continuation, last));
    });
    return lines.join("\n");
  }
  if (node instanceof OrderedList) {
    const lines = [`${linePrefix}OrderedList`];
    node.items.forEach((item, i) => {
      const last = i === node.items.length - 1;
      lines.push(dumpAST(item, indent + 1, continuation, last));
    });
    return lines.join("\n");
  }
  if (node instanceof ListItem) {
    const lines = [`${linePrefix}ListItem`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof HorizontalRule) return `${linePrefix}HorizontalRule`;
  if (node instanceof AlignBlock) {
    const lines = [`${linePrefix}AlignBlock (${node.align})`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof FunctionCall) {
    const argsRepr = node.rawArgs || "";
    const err = node.error ? `  !ERROR: ${node.error}` : "";
    return `${linePrefix}FunctionCall @${node.name}(${argsRepr})${err}`;
  }
  if (node instanceof Color) return `${linePrefix}Color #${node.color} "${node.text}"`;
  if (node instanceof Superscript) {
    const lines = [`${linePrefix}Superscript`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof Subscript) {
    const lines = [`${linePrefix}Subscript`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof RawHtml) return `${linePrefix}RawHtml ${node.html}`;
  if (node instanceof FootnoteRef) return `${linePrefix}FootnoteRef [${node.label}] #${node.number}`;
  if (node instanceof Bold) {
    const lines = [`${linePrefix}Bold`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof Italic) {
    const lines = [`${linePrefix}Italic`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof Strikethrough) {
    const lines = [`${linePrefix}Strikethrough`];
    lines.push(..._dumpInlines(node.content, indent + 1, continuation));
    return lines.join("\n");
  }
  if (node instanceof InlineCode) return `${linePrefix}InlineCode \`${node.code}\``;
  if (node instanceof Link) return `${linePrefix}Link "${node.text}" -> ${node.url}`;
  if (node instanceof Image) {
    const lbl = node.label ? ` label=${node.label}` : "";
    return `${linePrefix}Image alt="${node.alt}" src="${node.url}"${lbl}`;
  }
  if (node instanceof Table) {
    const lbl = node.label ? ` (label=${node.label})` : "";
    return `${linePrefix}Table${lbl}`;
  }
  if (node instanceof RawText) return `${linePrefix}Text "${node.text}"`;
  if (node instanceof LineBreak) return `${linePrefix}LineBreak`;
  return `${linePrefix}${name}`;
}

// src/builtin.js
var RE_NUM_ARABIC = /^(\d+(?:\.\d+)*)/;
var RE_NUM_CN = /^(第[一二三四五六七八九十百]+[章节篇]|[一二三四五六七八九十百]+[、．.]|（[一二三四五六七八九十百]+）|\([一二三四五六七八九十百]+\))/;
function extractHeadingNumber(text, mode) {
  if (mode !== "1" && mode !== "\u4E00") return void 0;
  const re = mode === "1" ? RE_NUM_ARABIC : RE_NUM_CN;
  const m = text.match(re);
  if (!m) return void 0;
  let num = m[1];
  if (mode === "\u4E00") num = num.replace(/[、．.]+$/, "");
  return num;
}
function builtinFunctions(renderer) {
  const esc = (t) => renderer._esc(t);
  const escAttr = (t) => renderer._escAttr(t);
  return {
    if: (cond, then, els) => cond ? then : els === void 0 ? "" : els,
    not: (x) => !x,
    and: (...xs) => xs.every(Boolean),
    or: (...xs) => xs.some(Boolean),
    /** 文档内配置：@set({ headingNumbering: '1.1', ... })，无输出 */
    set: (config) => {
      if (config && typeof config === "object") renderer._mergeSet(config);
      return "";
    },
    /** 变量声明：@let("name", value)，无输出；变量全文档可见（预扫描注册） */
    let: (name, value) => {
      if (typeof name === "string") renderer._variables[name] = value;
      return "";
    },
    /** 文献键是否存在（供 if 条件使用） */
    has_cite: (key) => !!(renderer._data.bibliography && renderer._data.bibliography[key]),
    /** 术语是否存在（供 if 条件使用） */
    has_term: (name) => !!(renderer._data.terms && renderer._data.terms[name]),
    /** 文献引用：按文档出现顺序自动编号，输出上标链接 [n]，缺失时输出 [key?] 占位 */
    cite: (key) => {
      const entry = renderer._data.bibliography && renderer._data.bibliography[key];
      if (!entry) return `<sup>[${esc(String(key))}?]</sup>`;
      renderer._registerCite(key);
      const num = renderer._citeNumbers[key];
      return `<sup><a href="#cite-${num}" id="ref-cite-${num}">[${esc(String(num))}]</a></sup>`;
    },
    /** 交叉引用：图/表显示"图 N/表 N"（前缀随 captionPrefix 配置）；章节显示 显式编号 → 自动编号 → 标题全文 */
    ref: (label) => {
      const r = renderer._refs[label];
      if (!r) return `<a href="#${escAttr(String(label))}">[${esc(String(label))}?]</a>`;
      let text;
      if (r.kind === "fig") text = `${renderer._captionPrefix.fig} ${r.number}`;
      else if (r.kind === "tbl") text = `${renderer._captionPrefix.tbl} ${r.number}`;
      else text = r.display;
      return `<a href="#${escAttr(String(label))}">${esc(text)}</a>`;
    },
    /** 文献表：列出全部被引用文献（按编号顺序），生成 <ol> 锚点与 cite 对应 */
    bibliography: () => {
      const items = renderer._citeOrder.map((key, i) => {
        const entry = renderer._data.bibliography && renderer._data.bibliography[key];
        if (entry === void 0) return null;
        return `<li id="cite-${i + 1}">${renderer._formatBibEntry(entry)}</li>`;
      }).filter(Boolean);
      if (!items.length) return "";
      return `<ol class="bibliography">
${items.join("\n")}
</ol>`;
    },
    /** 术语引用：字符串值为 label 简写；对象可带 label / url */
    term: (name, kwargs) => {
      const entry = renderer._data.terms && renderer._data.terms[name];
      const label = typeof entry === "string" ? entry : entry && entry.label ? entry.label : name;
      const inner = `<span class="term">${esc(String(label))}</span>`;
      const url = entry && typeof entry === "object" && entry.url ? entry.url : "";
      return url ? `<a href="${escAttr(String(url))}">${inner}</a>` : inner;
    }
  };
}

// src/renderer.js
var ESC_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;"
};
var ESC_ATTR_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHTML(text) {
  return text.replace(/[&<>]/g, (ch) => ESC_MAP[ch] || ch);
}
function escapeAttr(text) {
  return text.replace(/[&<>"']/g, (ch) => ESC_ATTR_MAP[ch] || ch);
}
var _HTMLRenderer = class _HTMLRenderer {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.pretty=true]
   * @param {boolean} [opts.escapeHtml=true]
   * @param {Object<string, Function>} [opts.functions] - 自定义函数（覆盖同名内置函数）
   */
  constructor(opts = {}) {
    this.pretty = opts.pretty !== false;
    this.escapeHtml = opts.escapeHtml !== false;
    this._data = {};
    this._variables = {};
    this._functions = { ...builtinFunctions(this), ...opts.functions || {} };
    this._output = [];
  }
  /**
   * 注册自定义函数
   * @param {string} name
   * @param {Function} func
   */
  addFunction(name, func) {
    this._functions[name] = func;
  }
  /**
   * 渲染为 HTML 片段。
   *
   * @param {string|Document} source - mslang 文本或 Document AST
   * @param {object} [opts]
   * @param {string} [opts.wrapperClass='mslang']
   * @param {string} [opts.wrapperId='']
   * @param {object} [opts.data] - 注入数据（{ bibliography, terms, ... }）
   * @param {object} [opts.variables] - 注入变量（表达式裸词引用）
   * @param {string|boolean} [opts.headingNumbering] - 标题自动编号格式（如 '1.1'），
   *   开启后标题显示层级编号，@ref 显示编号；不配置则不编号
   * @param {string} [opts.refNumbering] - 从标题文本提取显式编号的模式
   *   （'1' 数字 / '一' 中文），提取到则 @ref 显示编号，否则显示标题全文
   * @returns {string}
   */
  render(source, opts = {}) {
    this._applyOpts(opts);
    const doc = this._parseDoc(source);
    this._applySets(doc);
    this._collectRefs(doc);
    doc.accept(this);
    const body = this._output.join("");
    return this._wrap(body, opts);
  }
  /**
   * 异步渲染：支持返回 Promise 的自定义函数（如网络请求）。
   * 与 render() 语义一致，仅异步函数结果会真正渲染进 HTML；
   * 多个异步函数并行等待，reject 时输出错误注释而非抛错。
   * @param {string|Document} source
   * @param {object} [opts] - 与 render() 相同
   * @returns {Promise<string>}
   */
  async renderAsync(source, opts = {}) {
    this._applyOpts(opts);
    this._asyncSlots = [];
    this._asyncId = 0;
    const doc = this._parseDoc(source);
    this._applySets(doc);
    this._collectRefs(doc);
    doc.accept(this);
    await Promise.all(this._asyncSlots.map((s) => s.promise));
    let body = this._output.join("");
    for (const slot of this._asyncSlots) {
      body = body.split(slot.token).join(slot.html);
    }
    return this._wrap(body, opts);
  }
  /**
   * 渲染多个文档的合并结果：跨文档连续编号、交叉引用、全局 @set。
   * @param {(string|Document)[]} sources - mslang 文本或 Document，顺序即编号顺序
   * @param {object} [opts] - 与 render() 相同
   * @returns {string}
   */
  renderAll(sources, opts = {}) {
    const docs = sources.map((s) => this._parseDoc(s));
    return this.render(mergeDocuments(...docs), opts);
  }
  /** 异步版 renderAll，语义与 renderAsync 相同 */
  async renderAllAsync(sources, opts = {}) {
    const docs = sources.map((s) => this._parseDoc(s));
    return this.renderAsync(mergeDocuments(...docs), opts);
  }
  /** 应用渲染选项（render / renderAsync 共用） */
  _applyOpts(opts) {
    const {
      data = {},
      variables = {},
      headingNumbering = "",
      refNumbering = "",
      captionPrefix = {}
    } = opts;
    this._data = data || {};
    this._variables = variables || {};
    this._headingNumbering = headingNumbering === true ? "1.1" : headingNumbering || "";
    this._refNumbering = refNumbering || "";
    this._captionPrefix = { ..._HTMLRenderer.DEFAULT_CAPTION_PREFIX, ...captionPrefix };
    this._evalCtx = { functions: this._functions, variables: this._variables };
    this._output = [];
    this._asyncSlots = null;
  }
  /** 解析输入为 Document（render / renderAsync 共用） */
  _parseDoc(source) {
    return source instanceof Document ? source : new Parser().parse(new Lexer(source).tokenize());
  }
  /** 包一层 wrapper div */
  _wrap(body, opts) {
    const wrapperClass = opts.wrapperClass || "mslang";
    const wrapperId = opts.wrapperId || "";
    const cls = wrapperClass ? ` class="${wrapperClass}"` : "";
    const id = wrapperId ? ` id="${wrapperId}"` : "";
    return `<div${cls}${id}>
${body}
</div>`;
  }
  /**
   * 预扫描文档顶层的 @set({...}) 调用并应用配置。
   * 必须在 _collectRefs 之前执行，使编号计算使用最终配置。
   * @set 全文档生效（建议放文档开头），仅识别块级内容中的顶层调用。
   */
  /**
   * 遍历文档全部行内节点（块 → 列表项 → 子项，递归穿过行内容器）。
   * _applySets / _collectRefs 共用，遍历顺序与渲染顺序一致。
   */
  _eachInline(doc, fn) {
    const walk = (inlines) => {
      for (const n of inlines) {
        fn(n);
        if (n.content) walk(n.content);
        if (n.caption) walk(n.caption);
      }
    };
    for (const block of doc.blocks) {
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
  }
  _applySets(doc) {
    this._eachInline(doc, (n) => {
      if (n instanceof FunctionCall && n.name === "set") this._applySet(n);
      else if (n instanceof FunctionCall && n.name === "let") this._applyLet(n);
    });
  }
  _applySet(node) {
    if (node.error || !node.args[0]) return;
    try {
      const config = evaluate(node.args[0], this._evalCtx);
      if (config && typeof config === "object") this._mergeSet(config);
    } catch (e) {
    }
  }
  /**
   * 预扫描注册 @let 声明的变量（与 _applySet 同步执行），
   * 使变量全文档可见：@set 参数、@ref 编号计算、渲染阶段均可引用。
   * 求值失败时忽略，渲染阶段由 let 函数输出错误注释。
   */
  _applyLet(node) {
    if (node.error || node.args.length < 2) return;
    try {
      const name = evaluate(node.args[0], this._evalCtx);
      const value = evaluate(node.args[1], this._evalCtx);
      if (typeof name === "string") this._variables[name] = value;
    } catch (e) {
    }
  }
  /** 白名单合并：@set 覆盖同名选项；terms/bibliography 增量合并（可多次设置） */
  _mergeSet(config) {
    for (const key of _HTMLRenderer.SET_KEYS) {
      if (!(key in config)) continue;
      if (key === "headingNumbering") {
        this._headingNumbering = config[key] === true ? "1.1" : config[key] || "";
      } else if (key === "refNumbering") {
        this._refNumbering = config[key] || "";
      } else if (key === "data") {
        this._data = this._mergeData(this._data, config[key]);
      } else if (key === "terms" || key === "bibliography") {
        this._data = this._mergeData(this._data, { [key]: config[key] });
      } else if (key === "variables") {
        Object.assign(this._variables, config[key] || {});
      } else if (key === "captionPrefix") {
        this._captionPrefix = { ...this._captionPrefix, ...config[key] };
      } else {
        this[key] = config[key];
      }
    }
  }
  /** 数据合并：一层深合并（terms/bibliography 按 key 合并），其余键整体替换 */
  _mergeData(existing, incoming) {
    if (!incoming || typeof incoming !== "object") return existing;
    const out = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      const isPlainObj = v && typeof v === "object" && !Array.isArray(v);
      if (isPlainObj && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
        out[k] = { ...out[k], ...v };
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  // ================================================================
  // 编号收集（渲染前对 AST 遍历一遍）
  // ================================================================
  /**
   * 收集引用编号，供渲染阶段回填：
   *   - cite("key") 按文档出现顺序编号 → _citeNumbers / _citeOrder
   *   - 图片/表格/标题的 label → _refs { label: { kind, number } }
   * 遍历顺序与渲染顺序一致（块 → 行内 → 表达式参数）。
   */
  _collectRefs(doc) {
    this._citeNumbers = {};
    this._citeOrder = [];
    this._refs = {};
    this._headingSeq = [];
    this._headingIdx = 0;
    const counters = { fig: 0, tbl: 0, sec: 0 };
    const sep = this._headingNumbering.match(/[^\d1]/)?.[0] || ".";
    const levelCounts = [0, 0, 0, 0, 0, 0];
    const nextSecNumber = (level) => {
      levelCounts[level - 1]++;
      for (let i = level; i < 6; i++) levelCounts[i] = 0;
      const parts = [];
      for (let i = 0; i < level; i++) parts.push(levelCounts[i]);
      return parts.join(sep);
    };
    const walkExpr = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "call") {
        if (node.name === "cite" && node.args[0] && node.args[0].type === "string") {
          this._registerCite(node.args[0].value);
        }
        node.args.forEach(walkExpr);
        Object.values(node.kwargs).forEach(walkExpr);
      } else if (node.type === "unary") {
        walkExpr(node.operand);
      } else if (node.type === "binary") {
        walkExpr(node.left);
        walkExpr(node.right);
      } else if (node.type === "object") {
        Object.values(node.value).forEach(walkExpr);
      } else if (node.type === "array") {
        node.items.forEach(walkExpr);
      }
    };
    const walkInlines = (n) => {
      if (n instanceof Image && n.label) {
        counters.fig++;
        this._refs[n.label] = { kind: "fig", number: counters.fig };
      }
      if (n instanceof FunctionCall) {
        if (n.name === "cite" && n.args[0] && n.args[0].type === "string") {
          this._registerCite(n.args[0].value);
        }
        n.args.forEach(walkExpr);
      }
    };
    const headingText = (nodes) => {
      let out = "";
      for (const n of nodes) {
        if (n instanceof RawText) out += n.text;
        else if (n.content) out += headingText(n.content);
      }
      return out;
    };
    this._eachInline(doc, walkInlines);
    for (const block of doc.blocks) {
      if (block instanceof Heading) {
        const autoNum = this._headingNumbering ? nextSecNumber(block.level) : "";
        this._headingSeq.push(autoNum);
        if (block.id) {
          counters.sec++;
          const text = headingText(block.content);
          let display;
          if (this._refNumbering) {
            display = extractHeadingNumber(text, this._refNumbering);
          }
          if (display === void 0 && autoNum) display = autoNum;
          if (display === void 0) display = text || `\u7B2C ${counters.sec} \u8282`;
          this._refs[block.id] = { kind: "sec", display };
        }
      }
      if (block instanceof Table && block.label) {
        counters.tbl++;
        this._refs[block.label] = { kind: "tbl", number: counters.tbl };
      }
    }
  }
  /**
   * 文献键编号：首次出现分配顺序号（_collectRefs 预收集与运行时 cite 共用）。
   * @param {string} key
   */
  _registerCite(key) {
    if (!(key in this._citeNumbers)) {
      this._citeNumbers[key] = this._citeOrder.length + 1;
      this._citeOrder.push(key);
    }
  }
  /** 文献条目格式化：字符串原样转义；对象拼接 authors (year). title. journal. */
  _formatBibEntry(entry) {
    if (typeof entry === "string") return this._esc(entry);
    const e = entry || {};
    const parts = [];
    if (e.authors) parts.push(this._esc(String(e.authors)));
    if (e.year !== void 0) parts.push(`(${this._esc(String(e.year))})`);
    const title = e.title ? this._esc(String(e.title)) : "";
    if (e.url) parts.push(`<a href="${this._escAttr(String(e.url))}">${title}</a>`);
    else if (title) parts.push(title);
    if (e.journal) parts.push(this._esc(String(e.journal)));
    return parts.join(" ");
  }
  // ================================================================
  // Visitor 实现
  // ================================================================
  genericVisit(node) {
    this._write(`<!-- unhandled: ${node.constructor.name} -->`);
  }
  visit_Document(doc) {
    doc.blocks.forEach((block, i) => {
      block.accept(this);
      if (this.pretty && i < doc.blocks.length - 1) this._write("\n");
    });
    if (Object.keys(doc.footnotes).length > 0) {
      if (this.pretty) this._write("\n");
      this._write("<hr>");
      if (this.pretty) this._write("\n");
      this._write("<ol>");
      if (this.pretty) this._write("\n");
      let idx = 0;
      for (const [label, text] of Object.entries(doc.footnotes)) {
        idx++;
        this._write(`<li id="fn-${idx}">${this._esc(text)} <a href="#fnref-${idx}">&#8617;</a></li>`);
        if (this.pretty) this._write("\n");
      }
      this._write("</ol>");
      if (this.pretty) this._write("\n");
    }
  }
  visit_Heading(node) {
    const tag = `h${Math.min(node.level, 6)}`;
    const idAttr = node.id ? ` id="${node.id}"` : "";
    this._write(`<${tag}${idAttr}>`);
    if (this._headingNumbering) {
      const num = this._headingSeq[this._headingIdx] || "";
      this._headingIdx++;
      if (num) this._write(`${num} `);
    }
    node.content.forEach((n) => n.accept(this));
    this._write(`</${tag}>`);
    if (this.pretty) this._write("\n");
  }
  visit_Paragraph(node) {
    if (node.content.length === 1 && node.content[0] instanceof Image && node.content[0].caption.length) {
      this._visitFigure(node.content[0]);
      return;
    }
    if (node.content.length && node.content.every((n) => n instanceof LineBreak)) {
      node.content.forEach(() => {
        this._write("<br>");
        if (this.pretty) this._write("\n");
      });
      return;
    }
    this._write("<p>");
    node.content.forEach((n) => n.accept(this));
    this._write("</p>");
    if (this.pretty) this._write("\n");
  }
  visit_BlockQuote(node) {
    this._write("<blockquote>");
    if (this.pretty) this._write("\n");
    node.content.forEach((n) => n.accept(this));
    if (this.pretty) this._write("\n");
    this._write("</blockquote>");
    if (this.pretty) this._write("\n");
  }
  /** 带 caption 的图片渲染为 <figure>（图下方 figcaption） */
  _visitFigure(image) {
    const ref = this._refs[image.label];
    const num = ref ? ref.number : "";
    const id = image.label ? ` id="${this._escAttr(image.label)}"` : "";
    const width = image.width ? ` width="${image.width}"` : "";
    this._write(`<figure${id}>`);
    if (this.pretty) this._write("\n");
    this._write(`<img src="${this._escAttr(image.url)}" alt="${this._escAttr(image.alt)}"${width} referrerpolicy="no-referrer">`);
    if (this.pretty) this._write("\n");
    this._write(`<figcaption>${this._esc(this._captionPrefix.fig)} ${num}\uFF1A`);
    image.caption.forEach((n) => n.accept(this));
    this._write("</figcaption>");
    if (this.pretty) this._write("\n");
    this._write("</figure>");
    if (this.pretty) this._write("\n");
  }
  visit_CodeBlock(node) {
    const langAttr = node.language ? ` data-language="${this._escAttr(node.language)}"` : "";
    this._write(`<pre${langAttr}><code>`);
    this._write(this._esc(node.code));
    this._write("</code></pre>");
    if (this.pretty) this._write("\n");
  }
  visit_UnorderedList(node) {
    this._write("<ul>");
    if (this.pretty) this._write("\n");
    node.items.forEach((item) => item.accept(this));
    this._write("</ul>");
    if (this.pretty) this._write("\n");
  }
  visit_OrderedList(node) {
    this._write("<ol>");
    if (this.pretty) this._write("\n");
    node.items.forEach((item) => item.accept(this));
    this._write("</ol>");
    if (this.pretty) this._write("\n");
  }
  visit_ListItem(node) {
    this._write("<li>");
    if (node.checked !== null) {
      const checked = node.checked ? " checked" : "";
      this._write(`<input type="checkbox" disabled${checked}>`);
      this._write("<label>");
    }
    node.content.forEach((n) => n.accept(this));
    node.children.forEach((child) => child.accept(this));
    if (node.checked !== null) this._write("</label>");
    this._write("</li>");
    if (this.pretty) this._write("\n");
  }
  visit_HorizontalRule(node) {
    this._write("<hr>");
    if (this.pretty) this._write("\n");
  }
  visit_AlignBlock(node) {
    const style = `text-align:${node.align}`;
    this._write(`<div style="${style}">`);
    node.content.forEach((n) => n.accept(this));
    this._write("</div>");
    if (this.pretty) this._write("\n");
  }
  visit_Table(node) {
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : "";
    this._write(`<table${id}>`);
    if (this.pretty) this._write("\n");
    if (node.caption.length) {
      const ref = this._refs[node.label];
      const num = ref ? ref.number : "";
      this._write(`<caption>${this._esc(this._captionPrefix.tbl)} ${num}\uFF1A`);
      node.caption.forEach((n) => n.accept(this));
      this._write("</caption>");
      if (this.pretty) this._write("\n");
    }
    if (node.headers.length) {
      this._write("<thead><tr>");
      node.headers.forEach((h) => this._write(`<th>${this._esc(h)}</th>`));
      this._write("</tr></thead>");
      if (this.pretty) this._write("\n");
    }
    if (node.rows.length) {
      this._write("<tbody>");
      if (this.pretty) this._write("\n");
      node.rows.forEach((row) => {
        this._write("<tr>");
        row.forEach((cell) => this._write(`<td>${this._esc(cell)}</td>`));
        this._write("</tr>");
        if (this.pretty) this._write("\n");
      });
      this._write("</tbody>");
      if (this.pretty) this._write("\n");
    }
    this._write("</table>");
    if (this.pretty) this._write("\n");
  }
  // ================================================================
  // 行内节点
  // ================================================================
  visit_RawText(node) {
    this._write(this._esc(node.text));
  }
  visit_LineBreak(node) {
    this._write("<br>");
  }
  visit_Bold(node) {
    this._write("<strong>");
    node.content.forEach((n) => n.accept(this));
    this._write("</strong>");
  }
  visit_Italic(node) {
    this._write("<em>");
    node.content.forEach((n) => n.accept(this));
    this._write("</em>");
  }
  visit_Strikethrough(node) {
    this._write("<del>");
    node.content.forEach((n) => n.accept(this));
    this._write("</del>");
  }
  visit_InlineCode(node) {
    this._write(`<code>${this._esc(node.code)}</code>`);
  }
  visit_Link(node) {
    this._write(`<a href="${this._escAttr(node.url)}">${this._esc(node.text)}</a>`);
  }
  visit_Image(node) {
    const w = node.width ? ` width="${node.width}"` : "";
    const id = node.label ? ` id="${this._escAttr(node.label)}"` : "";
    this._write(`<img src="${this._escAttr(node.url)}" alt="${this._escAttr(node.alt)}"${w}${id} referrerpolicy="no-referrer">`);
  }
  visit_FunctionCall(node) {
    if (node.error) {
      this._write(`<!-- mslang: \u53C2\u6570\u89E3\u6790\u9519\u8BEF @${node.name}: ${this._esc(node.error)} -->`);
      return;
    }
    const func = this._functions[node.name];
    if (!func) {
      this._write(`<!-- mslang: unknown function @${node.name} -->`);
      return;
    }
    let result;
    try {
      const args = node.args.map((a) => evaluate(a, this._evalCtx));
      const kwargs = {};
      for (const [k, v] of Object.entries(node.kwargs)) kwargs[k] = evaluate(v, this._evalCtx);
      result = func(...args, kwargs);
    } catch (e) {
      this._write(this._functionError(node.name, e));
      return;
    }
    if (result instanceof Promise) {
      if (this._asyncSlots) {
        const id = ++this._asyncId;
        const slot = { token: `\0ASYNC${id}\0`, html: "" };
        slot.promise = Promise.resolve(result).then(
          (value) => {
            slot.html = this._renderValue(value);
          },
          (err) => {
            slot.html = this._functionError(node.name, err, true);
          }
        );
        this._asyncSlots.push(slot);
        this._output.push(slot.token);
      } else {
        this._write(`<!-- mslang: async function @${node.name} \u9700\u4F7F\u7528 renderAsync() -->`);
      }
      return;
    }
    this._write(this._renderValue(result));
  }
  /** 函数调用错误注释（同步/异步共用） */
  _functionError(name, err, isAsync) {
    const prefix = isAsync ? "async function" : "function";
    const msg = isAsync ? String(err && err.message || err) : String(err);
    return `<!-- mslang: ${prefix} @${name} error: ${this._esc(msg)} -->`;
  }
  /**
   * 将函数返回值渲染为 HTML 字符串：
   * 字符串原样输出（视为 HTML）；数组逐项处理（字符串转义、AST 节点递归渲染）；
   * 其他值转义后输出。
   */
  _renderValue(result) {
    if (typeof result === "string") return result;
    if (Array.isArray(result)) {
      return result.map((item) => {
        if (typeof item === "string") return this._esc(item);
        if (item && item.accept) return this._renderSubtree(item);
        return "";
      }).join("");
    }
    return this._esc(String(result));
  }
  /** 在独立输出缓冲中渲染子树，返回 HTML 字符串 */
  _renderSubtree(node) {
    const saved = this._output;
    this._output = [];
    node.accept(this);
    const html = this._output.join("");
    this._output = saved;
    return html;
  }
  visit_Color(node) {
    this._write(`<span style="color:#${node.color}">${this._esc(node.text)}</span>`);
  }
  visit_Superscript(node) {
    this._write("<sup>");
    node.content.forEach((n) => n.accept(this));
    this._write("</sup>");
  }
  visit_Subscript(node) {
    this._write("<sub>");
    node.content.forEach((n) => n.accept(this));
    this._write("</sub>");
  }
  visit_RawHtml(node) {
    this._write(node.html);
  }
  visit_FootnoteRef(node) {
    this._write(`<sup><a href="#fn-${node.number}" id="fnref-${node.number}">[${node.number}]</a></sup>`);
  }
  // ================================================================
  // 辅助方法
  // ================================================================
  _write(text) {
    this._output.push(text);
  }
  _esc(text) {
    if (this.escapeHtml) return escapeHTML(text);
    return text;
  }
  _escAttr(text) {
    if (this.escapeHtml) return escapeAttr(text);
    return text;
  }
};
// ================================================================
// 文档内配置（@set）
// ================================================================
// @set 白名单：仅这些键可被文档内配置覆盖
__publicField(_HTMLRenderer, "SET_KEYS", ["headingNumbering", "refNumbering", "escapeHtml", "pretty", "data", "variables", "terms", "bibliography", "captionPrefix"]);
// caption 前缀（默认中文，可用 @set 覆盖）
__publicField(_HTMLRenderer, "DEFAULT_CAPTION_PREFIX", { fig: "\u56FE", tbl: "\u8868" });
var HTMLRenderer = _HTMLRenderer;

// src/index.js
function mslangToHTML(source, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.render(source, _renderOptions(options));
}
async function mslangToHTMLAsync(source, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.renderAsync(source, _renderOptions(options));
}
function mslangToHTMLAll(sources, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.renderAll(sources, _renderOptions(options));
}
async function mslangToHTMLAllAsync(sources, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.renderAllAsync(sources, _renderOptions(options));
}
function _renderOptions(options) {
  return {
    wrapperClass: options.wrapperClass || "mslang",
    wrapperId: options.wrapperId || "",
    data: options.data,
    variables: options.variables,
    headingNumbering: options.headingNumbering,
    refNumbering: options.refNumbering,
    captionPrefix: options.captionPrefix
  };
}
export {
  AlignBlock,
  BlockQuote,
  Bold,
  CHAR,
  CodeBlock,
  Color,
  Document,
  EvalError,
  FootnoteRef,
  FunctionCall,
  HTMLRenderer,
  Heading,
  HorizontalRule,
  Image,
  InlineCode,
  Italic,
  Lexer,
  LexerError,
  LineBreak,
  Link,
  ListItem,
  OrderedList,
  Paragraph,
  Parser,
  ParserError,
  Position,
  RawHtml,
  RawText,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Token,
  TokenType,
  UnorderedList,
  dumpAST,
  evaluate,
  mergeDocuments,
  mslangToHTML,
  mslangToHTMLAll,
  mslangToHTMLAllAsync,
  mslangToHTMLAsync,
  parseArgs,
  parseExpression
};
/*! built: 2026-08-08T05:04:18.833Z */
