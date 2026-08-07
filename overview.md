# mslang-js 转换完成

## 做了什么

将 Python 实现的 mslang (轻量级排版语言) 库完整转换为 JavaScript，使其可直接在浏览器和 Node.js 中使用。

## 项目结构

```
mslang-js/
├── package.json         # npm 包配置 (ES Module)
├── index.html           # 浏览器端交互式演示页面
├── src/
│   ├── index.js         # 入口模块，导出全部 API + 便捷函数 mslangToHTML()
│   ├── tokens.js        # Token 类型枚举、Position、Token 类
│   ├── lexer.js         # 词法解析器 (源文本 → Token 流)
│   ├── nodes.js         # AST 节点定义 (Document, Heading, Paragraph, ...)
│   ├── parser.js        # 语法解析器 (Token 流 → AST)
│   └── renderer.js      # HTML 渲染器 (AST → HTML，Visitor 模式)
└── dist/                # (预留) 打包输出目录
```

## 架构保持一致

三层解耦设计完整保留：

```
源文本 → Lexer (词法) → Token 流 → Parser (语法) → AST → Renderer → HTML
```

## 关键转换对照

| Python | JavaScript |
|--------|------------|
| `enum.Enum` / `auto()` | 冻结对象 `TokenType` 带 `name`/`value` |
| `@dataclass` | ES6 `class` + `constructor` |
| `abc.ABC` / `@abstractmethod` | 基类 + `throw new Error()` |
| `re.compile` | 模块级 `RegExp` 常量 |
| `typing.List[T]` | JSDoc `@param {T[]}` |
| `visit_XXX` 方法 | 同名方法，手写调用链 |
| Python `html.escape` | 自实现 `escapeHTML` / `escapeAttr` |
| `**kwargs` | `{ functions }` 对象传入 |

## 修复的问题

- **Windows CRLF 换行**: Lexer 构造时统一 `\r\n|\r` → `\n`，确保块级识别正常
- **ES Module re-export 绑定**: `export { X } from` 不绑定局部变量 → 改为先 `import` 再 `export`

## 实测验证

- ✅ 9 项单元测试全部通过 (标题、加粗斜体、代码块、表格、任务列表、上标下标、颜色、链接图片、脚注)
- ✅ `main.msl` 完整渲染正确 (包含标题、表格、嵌套列表、引用、任务列表、HTML透传、脚注等全部功能)
- ✅ 浏览器演示页面可交互使用 (实时编辑、Token流/AST/HTML 三种视图切换)

## 使用方式

```javascript
// ES Module (浏览器 / Node.js)
import { mslangToHTML, HTMLRenderer, Parser, Lexer } from 'mslang';

// 快捷渲染
const html = mslangToHTML('# Hello\n\n**bold** text');

// 注册自定义函数
const renderer = new HTMLRenderer();
renderer.addFunction('greet', (name) => `<b>Hello ${name}!</b>`);

// 表达式：逻辑运算、文献/术语引用（数据经 render / mslangToHTML 注入）
const html2 = mslangToHTML('@if(has_cite("doe2020"), cite("doe2020"), "（待补充）")', {
  data: { bibliography: { doe2020: { number: 1 } } },
});

// 论文写作：cite 自动编号、@ref 交叉引用（图/表/章节）、@bibliography 文献表
const paper = mslangToHTML(
  '# 引言 {#sec:intro}\n\n' +
  '如 @ref("fig:1") 所示，结果见 @cite("doe2020")。\n\n' +
  '![结果](r.png){#fig:1}\n\n' +
  '| 方法 | 准确率 | {#tbl:1} |\n| --- | --- |\n| A | 0.9 |\n\n' +
  '见表 @ref("tbl:1")。\n\n@bibliography()',
  { data: { bibliography: { doe2020: { authors: 'Doe, J.', year: 2020, title: 'A Study' } } } },
);

// 仅解析 AST
const parser = new Parser();
const ast = parser.parseText('# Hello');
```

## 后续可做

- 添加 `.d.ts` TypeScript 类型声明
- rollup/esbuild 打包 UMD 单文件 (dist/mslang.bundle.js)
- npm publish
- 更多渲染目标 (纯文本、React 组件、Vue 组件)
