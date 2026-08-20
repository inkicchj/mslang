# mslang

轻量级学术标记语言（JavaScript/TypeScript）。面向论文写作与 AI 文献工作台：
容错渲染、引用/术语/交叉引用、块级编辑、跨文档引用、语义分析入口。

**0.3（学术语义版本）**：论文结构语义化优先——`@meta` 文档头部、CSL-JSON 数据模型 +
CitationEngine（自动探测 `@citation-js` 启用 CSL 样式）、include 后的 SourceMap 溯源、
脚注同 label 共享编号、SemanticModel 论文分析模型（outline/sections/stats）、学术一致性
诊断（unused-bibliography / unreferenced-figure…）、实验性 LaTeXRenderer（`renderLatex`）。

## 用户层心智模型

```text
source
  → render()        → HTML
  → renderLatex()   → LaTeX（实验性）
  → analyze()       → { document, semantic, sourceMap, diagnostics }
```

```bash
npm test        # node:test 运行 test/ 下测试（devDependencies 含 @citation-js 用于 CSL 测试）
npm run build   # esbuild 构建 dist/（esm / iife / iife.min）
```

```javascript
import { render, renderAsync, parse, analyze, renderLatex } from 'mslang';

const html = render('# 标题\n\n见 @cite("doe2024")', { data: { bibliography: { doe2024: {} } } });
const doc  = parse(source);                       // Stable AST（含 document.meta）
const { document, semantic, sourceMap, diagnostics } = analyze(source);  // 语义 + 分析 + 诊断
const h2   = await renderAsync(source, { functions: { lookup: async () => '...' } });
const tex  = renderLatex('# 标题');               // \section{标题} 等（零外壳）
```

## 开发者层心智模型

```text
Source
→ Parse（Raw AST）
→ Normalize（Stable AST：定理/@part/脚注）
→ Runtime（变量/函数/宏/配置链 Host > @set > Defaults）
→ Semantic（引用/编号/依赖/诊断 + 论文分析模型）
→ Render（HTML / 实验性 LaTeX）
```

唯一管线为 `prepare()`：`render` / `analyze` / `renderAsync` / `renderBlocks` / `renderLatex` 全部经它，保证语义一致。

```text
src/
├── tokens.js  lexer.js  parser.js  parse-utils.js  ast-utils.js  nodes.js
├── normalize.js  numbering.js  expression.js  runtime.js  builtin.js semantic.js
├── citation.js  meta.js  source-map.js  include.js  prepare.js
├── renderer.js  renderer-latex.js  blockeditor.js  escape.js
└── index.js
```

## 架构不变量

- Parser 只解析语法；Normalizer 只稳定 AST；Runtime 拥有执行状态；Semantic 拥有文档语义；Renderer 只渲染预备好的语义
- `prepare()` 是唯一管线（新功能如需 Parse → Runtime → Semantic 必须经它）
- 引用格式化收口到 `CitationEngine`：Semantic = meaning（谁引谁/顺序/缺失/span），Citation.js = formatting；SemanticAnalyzer 不 import citation.js
- 语言核心只做确定性检查（diag.academic），主观学术评价交 AI 工作台
- 安全：`allowPlugins` 默认关闭（文档无法自行打开）；URL scheme 白名单；宏递归深度限制
- 配置优先级 `Host > @set > Defaults`；host 显式设置的安全键文档不可覆盖

## License

Apache License 2.0（见 [LICENSE](./LICENSE)）。
