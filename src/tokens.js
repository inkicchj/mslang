/**
 * mslang Token 定义 (JavaScript)
 *
 * 定义词法解析阶段所有 Token 类型及其数据结构。
 * 每个 Token 带有行号、列号信息，便于错误定位。
 */

// ================================================================
// Token 类型枚举
// ================================================================

const _types = [
  // 块级元素
  'HEADING',
  'HORIZONTAL_RULE',
  'BLOCKQUOTE',
  'CODE_BLOCK',
  'UNORDERED_LIST',
  'ORDERED_LIST',

  // 行内元素
  'BOLD',
  'BOLD_ITALIC',
  'ITALIC',
  'STRIKETHROUGH',
  'INLINE_CODE',
  'LINK',
  'IMAGE',
  'FUNCTION_CALL',
  'COLOR',
  'SUPERSCRIPT',
  'SUBSCRIPT',
  'RAW_HTML',
  'TABLE_ROW',
  'TABLE_SEP',
  'FOOTNOTE_REF',
  'FOOTNOTE_DEF',
  'ALIGN_RIGHT',
  'ALIGN_CENTER',
  'CAPTION',
  'MATH',

  // 文本与空白
  'RAW_TEXT',
  'LINE_BREAK',
  'BLANK_LINE',

  // 特殊
  'EOF',
];

const TokenType = {};
_types.forEach((name, i) => {
  TokenType[name] = { name, value: i + 1 };
});

Object.freeze(TokenType);

// ================================================================
// 位置信息
// ================================================================

class Position {
  /** @param {number} line @param {number} col @param {number} index */
  constructor(line, col, index) {
    this.line = line;
    this.col = col;
    this.index = index;
  }

  toString() {
    return `L${this.line}:C${this.col}`;
  }
}

// ================================================================
// Token
// ================================================================

class Token {
  /**
   * @param {object} type - TokenType 成员
   * @param {Position} position
   * @param {string} [value]
   * @param {object|null} [metadata]
   */
  constructor(type, position, value = '', metadata = null) {
    this.type = type;
    this.position = position;
    this.value = value;
    this.metadata = metadata;
  }

  toString() {
    const meta = this.metadata ? ` | meta=${JSON.stringify(this.metadata)}` : '';
    return `Token(${this.type.name}, '${this.value.slice(0, 20)}', ${this.position}${meta})`;
  }
}

// ================================================================
// 字符常量
// ================================================================

const CHAR = Object.freeze({
  AT:         '@',
  SLASH:      '/',
  BACKTICK:   '`',
  STAR:       '*',
  UNDERSCORE: '_',
  TILDE:      '~',
  HASH:       '#',
  GT:         '>',
  HYPHEN:     '-',
  PLUS:       '+',
  DOT:        '.',
  BANG:       '!',
  LBRACKET:   '[',
  RBRACKET:   ']',
  LPAREN:     '(',
  RPAREN:     ')',
  PIPE:       '|',
  NEWLINE:    '\n',
});

export { TokenType, Position, Token, CHAR };
