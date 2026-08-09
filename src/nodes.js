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
  constructor(language = '', code = '', label = '') {
    super();
    this.language = language;
    this.code = code;
    this.label = label; // 起始行 {#label}（如 ```mermaid {#fig:flow}）
    /** @type {InlineNode[]} - 图表说明（caption 行归并） */
    this.caption = [];
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

/**
 * 图表 caption 行（内部节点，parse 阶段归并到前一块 Image/Table，
 * 孤立时降级为普通段落，不会出现在最终 AST）。
 */
class Caption extends BlockNode {
  constructor(label = '', content = [], raw = '') {
    super();
    this.label = label;
    this.content = content;
    this.raw = raw; // 原始整行文本（孤立降级时还原）
  }

  accept(visitor) { return visitor.visit_Caption(this); }
}

/**
 * 公式：$...$ 行内 / $$...$$ 块级。
 * source 为 LaTeX 源码（字段名避开 content，防止遍历器递归字符串）。
 * 命名避开全局 Math 对象（Equation）。
 */
class Equation extends ASTNode {
  constructor(source = '', inline = true, label = '') {
    super();
    this.source = source;
    this.inline = inline;
    this.label = label;
    /** @type {InlineNode[]} - 公式说明（caption 行归并） */
    this.caption = [];
  }

  accept(visitor) { return visitor.visit_Equation(this); }
}

class Table extends BlockNode {
  /**
   * @param {InlineNode[][]} [headers] - 表头单元格（行内节点数组）
   * @param {InlineNode[][][]} [rows] - 数据行单元格
   * @param {string} [label] - 交叉引用标签，如 "tbl:1"
   */
  constructor(headers = [], rows = [], label = '') {
    super();
    this.headers = headers;
    this.rows = rows;
    this.label = label;
    /** @type {InlineNode[]} - 表格说明（caption 行归并），渲染在表头上方 */
    this.caption = [];
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
   * @param {string} [label] - 交叉引用标签，如 "fig:1"
   */
  constructor(alt = '', url = '', width = '', label = '') {
    super();
    this.alt = alt;
    this.url = url;
    this.width = width;
    this.label = label;
    /** @type {InlineNode[]} - 图片说明（caption 行归并），渲染在图下方 */
    this.caption = [];
  }

  accept(visitor) { return visitor.visit_Image(this); }
}

class FunctionCall extends InlineNode {
  /**
   * @param {string} [name]
   * @param {object[]} [args] - 表达式 AST 列表
   * @param {Object<string, object>} [kwargs] - 关键字参数（表达式 AST）
   * @param {string} [rawArgs]
   * @param {string} [error] - 参数表达式解析错误信息（空串表示无错误）
   */
  constructor(name = '', args = [], kwargs = {}, rawArgs = '', error = '') {
    super();
    this.name = name;
    this.args = args;
    this.kwargs = kwargs;
    this.rawArgs = rawArgs;
    this.error = error;
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
  AlignBlock, Table, Caption, Equation,
  RawText, Bold, Italic, Strikethrough, InlineCode,
  Link, Image, FunctionCall, Color,
  Superscript, Subscript, RawHtml, FootnoteRef,
  LineBreak,
};
