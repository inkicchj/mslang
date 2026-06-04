/**
 * mslang AST 节点定义 (JavaScript)
 *
 * 语法解析器将 Token 流构建为抽象语法树（AST）。
 * 每个节点类型对应一种文档结构元素。
 * 使用 Visitor 模式支持遍历操作。
 */

// ============================================================
// 抽象基类
// ============================================================

class ASTNode {
  /** @param {NodeVisitor} visitor */
  accept(visitor) {
    throw new Error(`accept() not implemented for ${this.constructor.name}`);
  }
}

// ============================================================
// 文档根节点
// ============================================================

class Document extends ASTNode {
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
}

// ============================================================
// 块级节点
// ============================================================

class BlockNode extends ASTNode {}

class Heading extends BlockNode {
  /**
   * @param {number} level
   * @param {InlineNode[]} [content]
   * @param {string} [id]
   */
  constructor(level, content = [], id = '') {
    super();
    this.level = level;
    this.content = content;
    this.id = id;
  }

  accept(visitor) { return visitor.visit_Heading(this); }
}

class Paragraph extends BlockNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }

  accept(visitor) { return visitor.visit_Paragraph(this); }
}

class BlockQuote extends BlockNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }

  accept(visitor) { return visitor.visit_BlockQuote(this); }
}

class CodeBlock extends BlockNode {
  /**
   * @param {string} [language]
   * @param {string} [code]
   */
  constructor(language = '', code = '') {
    super();
    this.language = language;
    this.code = code;
  }

  accept(visitor) { return visitor.visit_CodeBlock(this); }
}

class UnorderedList extends BlockNode {
  /** @param {ListItem[]} [items] */
  constructor(items = []) {
    super();
    this.items = items;
  }

  accept(visitor) { return visitor.visit_UnorderedList(this); }
}

class OrderedList extends BlockNode {
  /** @param {ListItem[]} [items] */
  constructor(items = []) {
    super();
    this.items = items;
  }

  accept(visitor) { return visitor.visit_OrderedList(this); }
}

class ListItem extends ASTNode {
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

  accept(visitor) { return visitor.visit_ListItem(this); }
}

class HorizontalRule extends BlockNode {
  accept(visitor) { return visitor.visit_HorizontalRule(this); }
}

class AlignBlock extends BlockNode {
  /**
   * @param {string} [align] - 'left' | 'center' | 'right'
   * @param {InlineNode[]} [content]
   */
  constructor(align = 'left', content = []) {
    super();
    this.align = align;
    this.content = content;
  }

  accept(visitor) { return visitor.visit_AlignBlock(this); }
}

class Table extends BlockNode {
  /**
   * @param {string[]} [headers]
   * @param {string[][]} [rows]
   */
  constructor(headers = [], rows = []) {
    super();
    this.headers = headers;
    this.rows = rows;
  }

  accept(visitor) { return visitor.visit_Table(this); }
}

// ============================================================
// 行内节点
// ============================================================

class InlineNode extends ASTNode {}

class RawText extends InlineNode {
  /** @param {string} [text] */
  constructor(text = '') {
    super();
    this.text = text;
  }

  accept(visitor) { return visitor.visit_RawText(this); }
}

class Bold extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }

  accept(visitor) { return visitor.visit_Bold(this); }
}

class Italic extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }

  accept(visitor) { return visitor.visit_Italic(this); }
}

class Strikethrough extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }

  accept(visitor) { return visitor.visit_Strikethrough(this); }
}

class InlineCode extends InlineNode {
  /** @param {string} [code] */
  constructor(code = '') {
    super();
    this.code = code;
  }

  accept(visitor) { return visitor.visit_InlineCode(this); }
}

class Link extends InlineNode {
  /**
   * @param {string} [text]
   * @param {string} [url]
   */
  constructor(text = '', url = '') {
    super();
    this.text = text;
    this.url = url;
  }

  accept(visitor) { return visitor.visit_Link(this); }
}

class Image extends InlineNode {
  /**
   * @param {string} [alt]
   * @param {string} [url]
   * @param {string} [width] - 如 "80%"
   */
  constructor(alt = '', url = '', width = '') {
    super();
    this.alt = alt;
    this.url = url;
    this.width = width;
  }

  accept(visitor) { return visitor.visit_Image(this); }
}

class FunctionCall extends InlineNode {
  /**
   * @param {string} [name]
   * @param {string[]} [args]
   * @param {Object<string, string>} [kwargs]
   * @param {string} [rawArgs]
   */
  constructor(name = '', args = [], kwargs = {}, rawArgs = '') {
    super();
    this.name = name;
    this.args = args;
    this.kwargs = kwargs;
    this.rawArgs = rawArgs;
  }

  accept(visitor) { return visitor.visit_FunctionCall(this); }
}

class Color extends InlineNode {
  /**
   * @param {string} [color] - hex
   * @param {string} [text]
   */
  constructor(color = '', text = '') {
    super();
    this.color = color;
    this.text = text;
  }

  accept(visitor) { return visitor.visit_Color(this); }
}

class Superscript extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }

  accept(visitor) { return visitor.visit_Superscript(this); }
}

class Subscript extends InlineNode {
  /** @param {InlineNode[]} [content] */
  constructor(content = []) {
    super();
    this.content = content;
  }

  accept(visitor) { return visitor.visit_Subscript(this); }
}

class RawHtml extends InlineNode {
  /** @param {string} [html] */
  constructor(html = '') {
    super();
    this.html = html;
  }

  accept(visitor) { return visitor.visit_RawHtml(this); }
}

class FootnoteRef extends InlineNode {
  /**
   * @param {string} [label]
   * @param {number} [number]
   */
  constructor(label = '', number = 0) {
    super();
    this.label = label;
    this.number = number;
  }

  accept(visitor) { return visitor.visit_FootnoteRef(this); }
}

class LineBreak extends InlineNode {
  accept(visitor) { return visitor.visit_LineBreak(this); }
}

export {
  ASTNode,
  Document,
  BlockNode, InlineNode,
  Heading, Paragraph, BlockQuote, CodeBlock,
  UnorderedList, OrderedList, ListItem, HorizontalRule,
  AlignBlock, Table,
  RawText, Bold, Italic, Strikethrough, InlineCode,
  Link, Image, FunctionCall, Color,
  Superscript, Subscript, RawHtml, FootnoteRef,
  LineBreak,
};
