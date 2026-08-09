/**
 * mslang 表达式解析与求值 (Expression)
 *
 * 语法（优先级从低到高）：
 *   OrExpr     := AndExpr ( '||' AndExpr )*
 *   AndExpr    := CmpExpr ( '&&' CmpExpr )*
 *   CmpExpr    := AddExpr ( ('=='|'!='|'<'|'<='|'>'|'>=') AddExpr )*
 *   AddExpr    := MulExpr ( ('+'|'-') MulExpr )*
 *   MulExpr    := UnaryExpr ( ('*'|'/'|'%') UnaryExpr )*
 *   UnaryExpr  := ('!'|'-') UnaryExpr | Primary
 *   Primary    := number | string | true | false | null
 *               | identifier ('(' Args ')')?    // 函数调用或变量引用
 *               | '(' Expression ')'
 *
 * 顶层参数（@func(a, b=1)）：
 *   Args := (Arg (',' Arg)*)?
 *   Arg  := Expression | identifier '=' Expression
 *
 * 求值上下文 ctx：
 *   { functions: Object<string, Function>, variables: Object<string, any> }
 * 函数调用为严格求值（参数先求值），&& / || 支持短路。
 * 未定义的变量 / 函数 / 语法错误均抛出 Error，由渲染层兜底输出注释。
 */

// ================================================================
// 求值错误
// ================================================================

class EvalError extends Error {
  constructor(message) {
    super(`EvalError: ${message}`);
  }
}

// ================================================================
// 解析器
// ================================================================

class ExpressionParser {
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
    throw new Error(`表达式语法错误 @${this.pos}: ${message}`);
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
    if (this.pos < this.source.length) this._error(`意外的字符 '${this.source[this.pos]}'`);
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
      if (this._peek() === null || this._peek() === ')') break;
      const arg = this._parseArg();
      if (arg.kw) kwargs[arg.kw] = arg.node;
      else args.push(arg.node);
      this._skipWs();
      if (this._peek() === ',') { this.pos++; continue; }
      break;
    }
    return { args, kwargs };
  }

  _parseArg() {
    // 尝试 identifier '=' 形式的 kwargs（排除 '==' 比较符）
    const save = this.pos;
    const name = this._readIdentifier();
    if (name !== null) {
      this._skipWs();
      if (this._peek() === '=' && this.source[this.pos + 1] !== '=') {
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
      if (this._peek() !== '|' || this.source[this.pos + 1] !== '|') break;
      this.pos += 2;
      this._skipWs();
      left = { type: 'binary', op: '||', left, right: this._parseAnd() };
    }
    return left;
  }

  _parseAnd() {
    let left = this._parseCmp();
    while (true) {
      this._skipWs();
      if (this._peek() !== '&' || this.source[this.pos + 1] !== '&') break;
      this.pos += 2;
      this._skipWs();
      left = { type: 'binary', op: '&&', left, right: this._parseCmp() };
    }
    return left;
  }

  _parseCmp() {
    let left = this._parseAdd();
    while (true) {
      this._skipWs();
      let op = null;
      for (const candidate of ['==', '!=', '<=', '>=', '<', '>']) {
        if (this.source.startsWith(candidate, this.pos)) { op = candidate; break; }
      }
      if (!op) break;
      this.pos += op.length;
      this._skipWs();
      left = { type: 'binary', op, left, right: this._parseAdd() };
    }
    return left;
  }

  _parseAdd() {
    let left = this._parseMul();
    while (true) {
      this._skipWs();
      const ch = this._peek();
      if (ch !== '+' && ch !== '-') break;
      this.pos++;
      this._skipWs();
      left = { type: 'binary', op: ch, left, right: this._parseMul() };
    }
    return left;
  }

  _parseMul() {
    let left = this._parseUnary();
    while (true) {
      this._skipWs();
      const ch = this._peek();
      if (ch !== '*' && ch !== '/' && ch !== '%') break;
      this.pos++;
      this._skipWs();
      left = { type: 'binary', op: ch, left, right: this._parseUnary() };
    }
    return left;
  }

  _parseUnary() {
    this._skipWs();
    const ch = this._peek();
    if (ch === '!' || ch === '-') {
      this.pos++;
      this._skipWs();
      return { type: 'unary', op: ch, operand: this._parseUnary() };
    }
    return this._parsePrimary();
  }

  // ---- 基本项 ----

  _parsePrimary() {
    this._skipWs();
    const ch = this._peek();
    if (ch === null) this._error('表达式意外结束');

    if (ch === '(') {
      this.pos++;
      const node = this._parseOr();
      this._skipWs();
      if (this._peek() !== ')') this._error("缺少 ')'");
      this.pos++;
      return this._parsePostfix(node);
    }

    if (ch === '{') return this._parsePostfix(this._parseObject());

    if (ch === '[') return this._parsePostfix(this._parseArray());

    if (ch === '"' || ch === "'") return this._parsePostfix(this._parseString(ch));

    if (ch >= '0' && ch <= '9') return this._parsePostfix(this._parseNumber());

    const name = this._readIdentifier();
    if (name !== null) {
      if (name === 'true') return { type: 'bool', value: true };
      if (name === 'false') return { type: 'bool', value: false };
      if (name === 'null') return { type: 'null' };
      this._skipWs();
      if (this._peek() === '(') {
        this.pos++;
        const { args, kwargs } = this._parseArgsBody();
        this._skipWs();
        if (this._peek() !== ')') this._error("缺少 ')'");
        this.pos++;
        return this._parsePostfix({ type: 'call', name, args, kwargs });
      }
      return this._parsePostfix({ type: 'var', name });
    }

    this._error(`意外的字符 '${ch}'`);
  }

  /** 后缀：属性访问 x.y 与索引 x[expr]（可链式，如 a.b[0].c） */
  _parsePostfix(base) {
    while (true) {
      this._skipWs();
      const ch = this._peek();
      if (ch === '.') {
        this.pos++;
        const prop = this._readIdentifier();
        if (prop === null) this._error('属性访问缺少属性名');
        base = { type: 'member', object: base, property: prop };
      } else if (ch === '[') {
        this.pos++;
        const index = this._parseOr();
        this._skipWs();
        if (this._peek() !== ']') this._error("索引缺少 ']'");
        this.pos++;
        base = { type: 'index', object: base, index };
      } else {
        return base;
      }
    }
  }

  /** 数组字面量：[expr, expr, ...] */
  _parseArray() {
    this.pos++; // skip [
    const items = [];
    while (true) {
      this._skipWs();
      if (this._peek() === ']') { this.pos++; return { type: 'array', items }; }
      items.push(this._parseOr());
      this._skipWs();
      const c = this._peek();
      if (c === ',') { this.pos++; continue; }
      if (c === ']') { this.pos++; return { type: 'array', items }; }
      this._error("数组字面量缺少 ']'");
    }
  }

  /** 对象字面量：{ key: expr, ... }，键为任意字符（冒号前），支持中文 */
  _parseObject() {
    this.pos++; // skip {
    const obj = {};
    while (true) {
      this._skipWs();
      if (this._peek() === '}') { this.pos++; return { type: 'object', value: obj }; }
      // 键：读直到 ':' 的字符（trim 后），支持中文等任意键名
      let key = '';
      while (this.pos < this.source.length && this.source[this.pos] !== ':') {
        key += this.source[this.pos];
        this.pos++;
      }
      key = key.trim();
      if (!key) this._error('对象键不能为空');
      this.pos++; // skip :
      this._skipWs();
      obj[key] = this._parseOr();
      this._skipWs();
      const c = this._peek();
      if (c === ',') { this.pos++; continue; }
      if (c === '}') { this.pos++; return { type: 'object', value: obj }; }
      this._error("对象字面量缺少 '}'");
    }
  }

  _parseString(quote) {
    this.pos++; // skip quote
    let out = '';
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if (ch === '\\') {
        this.pos++;
        if (this.pos >= this.source.length) this._error('字符串转义不完整');
        out += this.source[this.pos];
        this.pos++;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        return { type: 'string', value: out };
      }
      out += ch;
      this.pos++;
    }
    this._error('字符串未闭合');
  }

  _parseNumber() {
    let j = this.pos;
    while (j < this.source.length && /[0-9]/.test(this.source[j])) j++;
    if (this.source[j] === '.' && /[0-9]/.test(this.source[j + 1] || '')) {
      j++;
      while (j < this.source.length && /[0-9]/.test(this.source[j])) j++;
    }
    const value = Number(this.source.slice(this.pos, j));
    this.pos = j;
    return { type: 'number', value };
  }
}

// ================================================================
// 求值器
// ================================================================

/**
 * 求值表达式节点
 * @param {object} node
 * @param {{ functions?: Object<string, Function>, variables?: Object<string, any> }} [ctx]
 * @returns {any}
 */
export function evaluate(node, ctx = {}) {
  const functions = ctx.functions || {};
  const variables = ctx.variables || {};

  switch (node.type) {
    case 'number':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'object': {
      const obj = {};
      for (const [k, v] of Object.entries(node.value)) obj[k] = evaluate(v, ctx);
      return obj;
    }
    case 'array':
      return node.items.map(item => evaluate(item, ctx));
    case 'var': {
      if (!(node.name in variables)) {
        throw new EvalError(`未定义的变量 '${node.name}'`);
      }
      return variables[node.name];
    }
    case 'call': {
      const func = functions[node.name];
      if (typeof func !== 'function') {
        throw new EvalError(`未定义的函数 '${node.name}'`);
      }
      const args = node.args.map(a => evaluate(a, ctx));
      const kwargs = {};
      for (const [k, v] of Object.entries(node.kwargs)) kwargs[k] = evaluate(v, ctx);
      return func(...args, kwargs);
    }
    case 'unary': {
      const v = evaluate(node.operand, ctx);
      return node.op === '!' ? !v : -v;
    }
    case 'member': {
      const obj = evaluate(node.object, ctx);
      return obj == null ? undefined : obj[node.property];
    }
    case 'index': {
      const obj = evaluate(node.object, ctx);
      const idx = evaluate(node.index, ctx);
      return obj == null ? undefined : obj[idx];
    }
    case 'binary': {
      const left = evaluate(node.left, ctx);
      if (node.op === '&&') return left ? evaluate(node.right, ctx) : left;
      if (node.op === '||') return left ? left : evaluate(node.right, ctx);
      const right = evaluate(node.right, ctx);
      switch (node.op) {
        case '==': return left === right;
        case '!=': return left !== right;
        case '<': return left < right;
        case '<=': return left <= right;
        case '>': return left > right;
        case '>=': return left >= right;
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
      }
      throw new EvalError(`未知运算符 '${node.op}'`);
    }
    default:
      throw new EvalError(`未知表达式节点 '${node.type}'`);
  }
}

// ================================================================
// 公共 API
// ================================================================

/** @param {string} source @returns {object} 表达式 AST */
export function parseExpression(source) {
  return new ExpressionParser(source).parse();
}

/** @param {string} raw @returns {{ args: object[], kwargs: Object<string, object> }} */
export function parseArgs(raw) {
  return new ExpressionParser(raw).parseArgs();
}

export { EvalError };
