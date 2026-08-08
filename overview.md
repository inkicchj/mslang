# mslang-js

轻量级排版语言 mslang 的 JavaScript 实现，面向 **AI 文献工作台**的论文写作：结构化标记、文献/术语/图表引用体系、表达式与动态数据、跨文档合并、异步渲染。

## 项目结构

```
mslang/
├── package.json         # npm 包配置 (ES Module)；npm test 运行测试套件
├── index.html           # 浏览器端交互式演示页面（需 HTTP 服务打开，file:// 下 ES Module 受限）
├── src/
│   ├── index.js         # 入口模块，导出全部 API + mslangToHTML 系列便捷函数
│   ├── tokens.js        # Token 类型枚举、Position、Token 类
│   ├── lexer.js         # 词法解析器 (源文本 → Token 流)
│   ├── expression.js    # 表达式解析器与求值（递归下降，变量/函数/字面量）
│   ├── nodes.js         # AST 节点定义 (Document, Heading, Paragraph, ...)
│   ├── parser.js        # 语法解析器 (Token 流 → AST) + mergeDocuments
│   ├── builtin.js       # 内置函数 (if/cite/term/ref/set/let/bibliography...)
│   ├── renderer.js      # HTML 渲染器 (AST → HTML，Visitor 模式)
│   └── escape.js        # HTML 转义纯函数（builtin/renderer 共用）
├── test/                # 测试套件（node:test，63 项）
└── dist/                # 构建产物 (esm / iife / iife.min)
```

## 架构

```
源文本 → Lexer → Token 流 → Parser → AST → Renderer → HTML
                    ↑                        ↑
              expression.js            builtin.js（内置函数）
```

- Lexer 是**唯一的行内语法识别器**；Parser 只做 Token → AST 映射
- 渲染管线：`parse → _applySets（@set/@let 预扫描）→ _collectRefs（编号收集）→ accept`
- 编号体系（cite/图/表/节）在 `_collectRefs` 一次遍历完成，跨文档合并后天然全局连续

## 使用方式

```javascript
import { mslangToHTML, mslangToHTMLAll, HTMLRenderer, Parser } from 'mslang';

// 快捷渲染
const html = mslangToHTML('# Hello\n\n**bold** text');

// 论文写作：cite 自动编号、@ref 交叉引用、@bibliography 文献表
const paper = mslangToHTML(
  '# 引言 {#sec:intro}\n\n' +
  '如 @ref("fig:1") 所示，结果见 @cite("doe2020")。\n\n' +
  '![结果](r.png){#fig:1}\n\n' +
  '见 @ref("sec:intro")。\n\n@bibliography()',
  { data: { bibliography: { doe2020: { authors: 'Doe, J.', year: 2020, title: 'A Study' } } } },
);
```

### 图表 caption

图表后一行 `{#label} 说明`（label 必须与图表 label 一致；孤立/不匹配时降级为普通段落）：

```
![图A](/a.png){#fig:1}

{#fig:1} 实验装置示意图        → <figure id="fig:1"><img ...><figcaption>图 1：实验装置示意图</figcaption></figure>

| x |{#tbl:t}|
|---|
| 1 |

{#tbl:t} 数据统计              → <table id="tbl:t"><caption>表 1：数据统计</caption>...
```

前缀可配置：`@set({ captionPrefix: { fig: "Figure", tbl: "Table" } })`（默认 `图/表`，`@ref` 显示与 caption 一致）。

### 文档内配置与变量

```javascript
// @set：配置写在 md 里（覆盖 API 同名选项，全文档生效，建议放开头）
// 白名单键：headingNumbering / refNumbering / escapeHtml / pretty / data /
//           variables / terms / bibliography / captionPrefix /
//           citeKeyAttr / termKeyAttr / refKeyAttr
mslangToHTML('@set({ headingNumbering: "1.1", refNumbering: "1" })\n\n# 引言 {#sec:intro}');

// @let：变量声明（预扫描注册，全文档可见；同名覆盖；值可为任意表达式）
mslangToHTML('@let("threshold", 5)\n\n@if(threshold > 3, "达标", "不足")');

// terms/bibliography 顶层键增量合并（多次 @set 按 key 合并；字符串值即显示文本）
mslangToHTML('@set({ terms: { 词干提取: "词干提取 (Stemming)" } })\n\n@term("词干提取")');
```

### 跨文档合并渲染

```javascript
// 多文档：编号跨文档连续、交叉引用、@set/@let 全局生效（顺序即编号顺序）
const html = mslangToHTMLAll(['引言.md', '方法.md', '参考文献.md'], { data: {...} });
// 异步版：mslangToHTMLAllAsync；AST 层：mergeDocuments(...docs)
```

### 公式（LaTeX 语法，内置 KaTeX 渲染）

```
行内：质能方程 $E = mc^2$ 是核心
块级：$$ \int_0^1 x dx $$
带编号：$$ E = mc^2 $$ {#eq:energy}          → @ref("eq:energy") 显示"式 1"
带说明：$$ x = 1 $$ {#eq:a}

{#eq:a} 归一化条件                            → <figure><div class="math">…</div><figcaption>式 1：…</figcaption></figure>
```

- `$...$` 行内（限同行）、`$$...$$` 块级（可跨行）；`\$` 转义字面美元；未闭合回退普通文本
- **默认内置 KaTeX 渲染**（`katex` 为正式依赖，开箱即用）：行内 `<span class="math-inline">` / 块级 `<div class="math">` 容器内为 KaTeX 输出（MathML + HTML 双轨）
- `mathRenderer` 选项可覆盖默认渲染（如自定义 KaTeX 选项或换其他引擎）；`throwOnError: false` 容错渲染错误公式
- 编号体系与图/表统一：`captionPrefix` 默认含 `eq: '式'`，跨文档合并自动连续

### 引用元数据（工作台交互）

`cite`/`term`/`ref` 输出携带 data 属性（点击证据 → 工作台定位文献库）：

```html
<a href="#cite-1" id="ref-cite-1" data-cite-key="doe2020" data-cite-index="0">[1]</a>
```

属性名可配置（`@set` 或 API 选项，空串关闭）：`citeKeyAttr`（默认 `data-cite-key`）/ `termKeyAttr`（默认 `data-term-key`）/ `refKeyAttr`（默认 `data-ref-label`，附带 `data-ref-kind`）。属性值恒转义（`escapeHtml: false` 时也防注入）。

### 异步渲染

```javascript
const renderer = new HTMLRenderer();
renderer.addFunction('fetch_title', async (key) => `<b>${key}</b>`);
const html = await mslangToHTMLAsync('标题：@fetch_title("paper1")'); // 或 renderer.renderAsync
```

### 其余 API

- 表达式：`parseExpression(source)` / `parseArgs(source)` / `evaluate(node, {functions, variables})`
- AST：`Parser.parse(tokens)` / `Parser.parseText(source)` / `dumpAST(doc)` / `mergeDocuments(...docs)`
- 渲染器：`new HTMLRenderer({ functions, escapeHtml, pretty })`，`render / renderAsync / renderAll / renderAllAsync`，`addFunction(name, fn)`

## 测试

```bash
npm test    # node:test 运行 test/ 下 63 项测试（零新依赖）
npm run build  # esbuild 构建 dist/（esm / iife / iife.min）
```

## 设计原则

- **显式优于隐式**：caption 需 `{#label}` 显式声明；`@ref` 显示"标题全文/编号"由配置显式决定
- **容错**：表达式错误、未知函数输出 HTML 注释而非崩溃（AI 生成场景友好）
- **零核心依赖**：KaTeX/Mermaid 等渲染器通过钩子/选项注入，核心库纯 JS
- **编辑层与出图层分离**：mslang 负责写作/交互（动态、容错、AST 可编程），最终 PDF 可由 `mslang → .typ` 转换链路交给 Typst 原生编译
