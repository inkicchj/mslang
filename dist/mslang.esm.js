/*! mslang v0.1.0 — Lightweight Markup Language | MIT License */

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
  "TABLE_ROW",
  "TABLE_SEP",
  "FOOTNOTE_REF",
  "FOOTNOTE_DEF",
  "ALIGN_RIGHT",
  "ALIGN_CENTER",
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
function parseFunctionArgs(raw) {
  const args = [];
  const kwargs = {};
  raw = raw.trim();
  if (!raw) return { args, kwargs };
  let current = "";
  let inSingle = false;
  let inDouble = false;
  const parts = [];
  for (const ch of raw) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === "," && !inSingle && !inDouble) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  for (const part of parts) {
    let eqPos = -1;
    for (let j = 0; j < part.length; j++) {
      if (part[j] === "=") {
        let inQ = false;
        let qCh = null;
        for (let k = 0; k < j; k++) {
          if (part[k] === '"' || part[k] === "'") {
            if (inQ && part[k] === qCh) inQ = false;
            else if (!inQ) {
              inQ = true;
              qCh = part[k];
            }
          }
        }
        if (!inQ) {
          eqPos = j;
          break;
        }
      }
    }
    if (eqPos > 0) {
      const key = part.slice(0, eqPos).trim();
      let val = part.slice(eqPos + 1).trim();
      val = unquote(val);
      kwargs[key] = val;
    } else {
      args.push(unquote(part));
    }
  }
  return { args, kwargs };
}
function unquote(s) {
  s = s.trim();
  if (s.length >= 2) {
    if (s[0] === '"' && s[s.length - 1] === '"' || s[0] === "'" && s[s.length - 1] === "'") {
      return s.slice(1, -1);
    }
  }
  return s;
}
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
    } else {
      this._inCodeBlock = true;
      const language = fenceLine.slice(3).trim();
      return new Token(
        TokenType.CODE_BLOCK,
        startPos,
        "",
        { fence_type: "start", language }
      );
    }
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
      return new Token(TokenType.RAW_TEXT, startPos, delimiter);
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
      return new Token(TokenType.RAW_TEXT, startPos, CHAR.BACKTICK);
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
      return new Token(TokenType.IMAGE, startPos, alt, { url, width });
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
    const rparen = this.source.indexOf(CHAR.RPAREN, this.pos);
    if (rparen === -1) return this._fallbackRawText(startPos, `@${funcName}(`);
    const rawArgs = this.source.slice(this.pos, rparen);
    this._advance(rawArgs.length + 1);
    const { args, kwargs } = parseFunctionArgs(rawArgs);
    return new Token(TokenType.FUNCTION_CALL, startPos, funcName, {
      args,
      kwargs,
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
  _scanRawText() {
    const start = this.pos;
    const specials = /* @__PURE__ */ new Set([
      CHAR.STAR,
      CHAR.UNDERSCORE,
      CHAR.TILDE,
      CHAR.BACKTICK,
      CHAR.BANG,
      CHAR.LBRACKET,
      CHAR.AT,
      "^",
      CHAR.NEWLINE
    ]);
    const end = this._lineEnd();
    while (this.pos < end) {
      const ch = this.source[this.pos];
      if (ch === "\\" && this.pos + 1 < this.source.length && specials.has(this.source[this.pos + 1])) {
        this._advance(2);
        continue;
      }
      if (specials.has(ch)) break;
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
    const text = this.source.slice(start, this.pos);
    return new Token(
      TokenType.RAW_TEXT,
      new Position(this.line, this.col - text.length, start),
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
    return new Token(TokenType.RAW_TEXT, startPos, text);
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
var Table = class extends BlockNode {
  /**
   * @param {string[]} [headers]
   * @param {string[][]} [rows]
   */
  constructor(headers = [], rows = []) {
    super();
    this.headers = headers;
    this.rows = rows;
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
   */
  constructor(alt = "", url = "", width = "") {
    super();
    this.alt = alt;
    this.url = url;
    this.width = width;
  }
  accept(visitor) {
    return visitor.visit_Image(this);
  }
};
var FunctionCall = class extends InlineNode {
  /**
   * @param {string} [name]
   * @param {string[]} [args]
   * @param {Object<string, string>} [kwargs]
   * @param {string} [rawArgs]
   */
  constructor(name = "", args = [], kwargs = {}, rawArgs = "") {
    super();
    this.name = name;
    this.args = args;
    this.kwargs = kwargs;
    this.rawArgs = rawArgs;
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
      if (token.type === TokenType.BLANK_LINE) break;
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
    while (!this._isAtEnd()) {
      const token = this._current();
      if (token.type !== TokenType.TABLE_ROW && token.type !== TokenType.TABLE_SEP) break;
      const cells = token.metadata ? token.metadata.cells || [] : [];
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
      for (const attr of ["content", "children", "blocks", "items"]) {
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
      return new Link(token.value, token.metadata.url || "");
    }
    if (token.type === TokenType.IMAGE) {
      this._advance();
      return new Image(
        token.value,
        token.metadata.url || "",
        token.metadata.width || ""
      );
    }
    if (token.type === TokenType.FUNCTION_CALL) {
      this._advance();
      return new FunctionCall(
        token.value,
        token.metadata.args || [],
        token.metadata.kwargs || {},
        token.metadata.raw_args || ""
      );
    }
    if (token.type === TokenType.COLOR) {
      this._advance();
      return new Color(token.metadata.color || "", token.value);
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
      if (text.startsWith("**", i)) {
        const end = text.indexOf("**", i + 2);
        if (end !== -1) {
          const inner = text.slice(i + 2, end);
          inlines.push(new Bold(this._parseInline(inner)));
          i = end + 2;
          matched = true;
        }
      } else if (text.startsWith("__", i)) {
        const end = text.indexOf("__", i + 2);
        if (end !== -1) {
          const inner = text.slice(i + 2, end);
          inlines.push(new Bold(this._parseInline(inner)));
          i = end + 2;
          matched = true;
        }
      } else if (text[i] === "*" && !text.startsWith("**", i)) {
        const end = text.indexOf("*", i + 1);
        if (end !== -1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Italic(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      } else if (text[i] === "_" && !text.startsWith("__", i)) {
        const end = text.indexOf("_", i + 1);
        if (end !== -1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Italic(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      } else if (text.startsWith("~~", i)) {
        const end = text.indexOf("~~", i + 2);
        if (end !== -1) {
          const inner = text.slice(i + 2, end);
          inlines.push(new Strikethrough(this._parseInline(inner)));
          i = end + 2;
          matched = true;
        }
      } else if (text[i] === "~" && !text.startsWith("~~", i)) {
        const end = text.indexOf("~", i + 1);
        if (end !== -1 && end > i + 1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Subscript(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      } else if (text[i] === "^") {
        const end = text.indexOf("^", i + 1);
        if (end !== -1 && end > i + 1) {
          const inner = text.slice(i + 1, end);
          inlines.push(new Superscript(this._parseInline(inner)));
          i = end + 1;
          matched = true;
        }
      } else if (text[i] === "`") {
        const end = text.indexOf("`", i + 1);
        if (end !== -1) {
          const code = text.slice(i + 1, end);
          inlines.push(new InlineCode(code));
          i = end + 1;
          matched = true;
        }
      } else if (text[i] === "[") {
        if (i + 1 < text.length && text[i + 1] === "^") {
          const end = text.indexOf("]", i + 2);
          if (end !== -1) {
            const label = text.slice(i + 2, end);
            inlines.push(new FootnoteRef(label));
            i = end + 1;
            matched = true;
          }
        } else {
          const textEnd = text.indexOf("]", i + 1);
          if (textEnd !== -1 && textEnd + 1 < text.length && text[textEnd + 1] === "(") {
            const urlEnd = text.indexOf(")", textEnd + 2);
            if (urlEnd !== -1) {
              const linkText = text.slice(i + 1, textEnd);
              const url = text.slice(textEnd + 2, urlEnd);
              inlines.push(new Link(linkText, url));
              i = urlEnd + 1;
              matched = true;
            }
          }
        }
      } else if (text.startsWith("![", i)) {
        const altEnd = text.indexOf("]", i + 2);
        if (altEnd !== -1 && altEnd + 1 < text.length && text[altEnd + 1] === "(") {
          const urlEnd = text.indexOf(")", altEnd + 2);
          if (urlEnd !== -1) {
            const alt = text.slice(i + 2, altEnd);
            const urlRaw = text.slice(altEnd + 2, urlEnd).trim();
            let url = urlRaw;
            let width = "";
            if (urlRaw.includes(" ")) {
              const parts = urlRaw.split(" ");
              const last = parts[parts.length - 1];
              if (last.endsWith("%") && /^\d+%$/.test(last)) {
                url = parts.slice(0, -1).join(" ");
                width = last;
              }
            }
            inlines.push(new Image(alt, url, width));
            i = urlEnd + 1;
            matched = true;
          }
        }
      } else if (text[i] === "@") {
        let j = i + 1;
        while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++;
        if (j > i + 1 && j < text.length && text[j] === "(") {
          const rp = text.indexOf(")", j + 1);
          if (rp !== -1) {
            const name = text.slice(i + 1, j);
            const rawArgs = text.slice(j + 1, rp);
            const { args, kwargs } = parseFunctionArgs(rawArgs);
            inlines.push(new FunctionCall(name, args, kwargs, rawArgs));
            i = rp + 1;
            matched = true;
          }
        }
      } else if (text.startsWith("/#", i)) {
        let j = i + 2;
        while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
        const hexLen = j - i - 2;
        if ([3, 6].includes(hexLen) && j < text.length && text[j] === ":") {
          const end = text.indexOf(":/", j + 1);
          if (end !== -1) {
            const color = text.slice(i + 2, j);
            const inner = text.slice(j + 1, end);
            inlines.push(new Color(color, inner));
            i = end + 2;
            matched = true;
          }
        }
      }
      if (!matched && text[i] === "\\") {
        const specials = /* @__PURE__ */ new Set(["*", "_", "~", "`", "[", "!", "@", "/", "\\"]);
        if (i + 1 < text.length && specials.has(text[i + 1])) {
          inlines.push(new RawText(text[i + 1]));
          i += 2;
          matched = true;
        }
      }
      if (!matched && text[i] === "<") {
        const end = text.indexOf(">", i + 1);
        if (end !== -1) {
          inlines.push(new RawHtml(text.slice(i, end + 1)));
          i = end + 1;
          matched = true;
        }
      }
      if (!matched) {
        let j = i + 1;
        const specials = /* @__PURE__ */ new Set(["*", "_", "~", "`", "[", "!", "@", "\\", "^", "<"]);
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
    return [
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
    ].includes(token.type) || token.type === TokenType.CODE_BLOCK && token.metadata && ["start", "end"].includes(token.metadata.fence_type);
  }
  // ================================================================
  // 调试 — AST 打印
  // ================================================================
  dumpAST(node) {
    return dumpAST(node);
  }
};
function _isSpacer(node) {
  return node instanceof Paragraph && node.content.length > 0 && node.content.every((n) => n instanceof LineBreak);
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
    return `${linePrefix}FunctionCall @${node.name}(${argsRepr})`;
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
  if (node instanceof Image) return `${linePrefix}Image alt="${node.alt}" src="${node.url}"`;
  if (node instanceof RawText) return `${linePrefix}Text "${node.text}"`;
  if (node instanceof LineBreak) return `${linePrefix}LineBreak`;
  return `${linePrefix}${name}`;
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
var HTMLRenderer = class {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.pretty=true]
   * @param {boolean} [opts.escapeHtml=true]
   * @param {Object<string, Function>} [opts.functions]
   */
  constructor(opts = {}) {
    this.pretty = opts.pretty !== false;
    this.escapeHtml = opts.escapeHtml !== false;
    this._functions = opts.functions || {};
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
   * @returns {string}
   */
  render(source, opts = {}) {
    const { wrapperClass = "mslang", wrapperId = "" } = opts;
    this._output = [];
    let body;
    if (source instanceof Document) {
      source.accept(this);
      body = this._output.join("");
    } else {
      const lexer = new Lexer(source);
      const tokens = lexer.tokenize();
      const ast = new Parser().parse(tokens);
      ast.accept(this);
      body = this._output.join("");
    }
    const cls = wrapperClass ? ` class="${wrapperClass}"` : "";
    const id = wrapperId ? ` id="${wrapperId}"` : "";
    return `<div${cls}${id}>
${body}
</div>`;
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
    node.content.forEach((n) => n.accept(this));
    this._write(`</${tag}>`);
    if (this.pretty) this._write("\n");
  }
  visit_Paragraph(node) {
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
    this._write("<table>");
    if (this.pretty) this._write("\n");
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
    this._write(`<img src="${this._escAttr(node.url)}" alt="${this._escAttr(node.alt)}"${w}>`);
  }
  visit_FunctionCall(node) {
    const func = this._functions[node.name];
    if (!func) {
      this._write(`<!-- mslang: unknown function @${node.name} -->`);
      return;
    }
    try {
      const result = func(...node.args, node.kwargs);
      if (typeof result === "string") {
        this._write(result);
      } else if (Array.isArray(result)) {
        result.forEach((item) => {
          if (typeof item === "string") {
            this._write(this._esc(item));
          } else if (item.accept) {
            item.accept(this);
          }
        });
      } else {
        this._write(this._esc(String(result)));
      }
    } catch (e) {
      this._write(`<!-- mslang: function @${node.name} error: ${this._esc(String(e))} -->`);
    }
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

// src/index.js
function mslangToHTML(source, options = {}) {
  const renderer = new HTMLRenderer({ functions: options.functions });
  return renderer.render(source, {
    wrapperClass: options.wrapperClass || "mslang",
    wrapperId: options.wrapperId || ""
  });
}
export {
  AlignBlock,
  BlockQuote,
  Bold,
  CHAR,
  CodeBlock,
  Color,
  Document,
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
  mslangToHTML,
  parseFunctionArgs,
  unquote
};
/*! built: 2026-06-04T15:23:54.122Z */
