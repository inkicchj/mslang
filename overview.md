# mslang-js 参考文档

轻量级排版语言 mslang 的 JavaScript 实现，面向 **AI 文献工作台**的论文写作：结构化标记、文献/术语/图表引用体系、表达式与动态数据、跨文档合并、异步渲染、块级编辑。

- 唯一入口 `render()`：字符串渲染、传数组自动合并、async/块级均为配置项
- 默认内置 **KaTeX**（公式）与 **highlight.js**（代码高亮），开箱即用
- 主要在前端（浏览器）使用，也支持 Node.js

## 目录

1. [快速上手](#快速上手)
2. [语法参考](#语法参考)
3. [表达式](#表达式)
4. [内置函数](#内置函数)
5. [数据（data）](#数据data)
6. [渲染选项](#渲染选项)
7. [异步渲染](#异步渲染)
8. [插件（文档内自定义函数）](#插件文档内自定义函数)
9. [跨文档合并](#跨文档合并)
10. [块级编辑](#块级编辑)
11. [引用元数据（工作台交互）](#引用元数据工作台交互)
12. [API 参考](#api-参考)
13. [测试与构建](#测试与构建)
14. [设计原则](#设计原则)

---

## 快速上手

```bash
npm install mslang
```

```javascript
import { render } from 'mslang';

const html = render('# 标题\n\n**加粗** 与 *斜体* 文本');
// <div class="mslang"><h1>标题</h1><p><strong>加粗</strong> 与 <em>斜体</em> 文本</p></div>
```

浏览器（IIFE 构建）：

```html
<script src="dist/mslang.iife.min.js"></script>
<script>document.body.innerHTML = mslang.render('# Hello');</script>
```

---

## 语法参考

### 块级语法

#### 标题

```md
# 一级标题          → <h1>
## 二级标题         → <h2>
###### 六级标题     → <h6>
```

带 id（供 `@ref` 引用）：

```md
# 引言 {#sec:intro}      → <h1 id="sec:intro">引言</h1>
```

#### 段落与换行

```md
第一段文本

第二段文本            ← 空行分段

同一段内
换行                  ← 单换行输出 <br>
```

#### 水平线

```md
---    （也支持 *** 与 ___，需至少 3 个相同字符）
```

#### 引用

```md
> 引用文本                → <blockquote>引用文本</blockquote>
> 第二行                  ← 连续 > 行合并，行间输出 <br>
>
> 空行后继续              ← 空行 + > 续行（同样以 <br> 分隔）
```

#### 列表

```md
- 无序项                → <ul><li>
* 星号也行
+ 加号也行

1. 有序项               → <ol><li>
2. 第二项

- 嵌套列表
  - 子项                ← 缩进 2 空格嵌套 <li><ul>...

- [ ] 待办任务           → <li><input type="checkbox" disabled>
- [x] 已完成             → checked
```

#### 注释

```md
% 这是注释（AI 生成痕迹，整行丢弃）     ← 行首 %，不产生任何输出
```

- 注释行**透明**：不影响段落/列表/引用结构（`甲\n% 注释\n乙` 仍为同一段）
- 代码块内、表格内、行内 `%`（如 `50%`）不受影响；`\%` 可输出行首字面 `%`

#### 代码块

````md
```js                    ← 围栏后跟语言名（js/ts/python/java/c/cpp/go/rust/bash/json/sql/xml/css/markdown）
const a = 1;
```
````

- 无语言：` ``` ` 纯文本输出
- 已知语言：**自动高亮**，输出 `<code class="hljs language-js">`，并内联 github 主题 CSS
- 转义安全：代码内容恒转义（`escapeHtml: false` 时也安全）

#### 表格

```md
| 表头1 | 表头2 |{#tbl:t}      ← 表头行（行尾可选 {#label} 供 @ref 引用）
|-------|-------|               ← 分隔行（--- 数量不限）
| 数据1 | 数据2 |               → <table id="tbl:t"><thead><th>…</thead><tbody><td>…
| 数据3 | 数据4 |
```

单元格支持**全部行内语法**：`| **加粗** | @cite("a") | $x^2$ | [链接](url) |`

表格 caption 写在表格**后一行**（见 [caption](#caption)），渲染为表头上方 `<caption>表 1：…</caption>`。

#### 对齐块

```md
>> 右对齐文本        → <div style="text-align:right">
-><- 居中文本        → <div style="text-align:center">
```

#### caption

图表（图片/公式/表格/mermaid）的说明行，写在目标**后一行**，label 必须一致：

```md
![图A](/a.png){#fig:1}

{#fig:1} 实验装置示意图
→ <figure id="fig:1"><img …><figcaption>图 1：实验装置示意图</figcaption></figure>
```

- 孤立/不匹配的 caption 行降级为普通段落（保留原文）
- 编号前缀可配置：`@set({ captionPrefix: { fig: "Figure", tbl: "Table", eq: "Eq" } })`（默认 `图/表/式`）
- `@ref` 显示与 caption 前缀一致

#### 脚注定义

```md
正文引用见下[^n1]

[^n1]: 脚注内容        ← 定义可写在文档任意位置（行首 [^label]:）
```

脚注区在文档末尾自动渲染为 `<ol>`（`<li id="fn-1">` + 返回链接）。

#### 块级公式

```md
$$ E = mc^2 $$                 → <div class="math">…KaTeX…</div>（可跨行）

$$ x = 1 $$ {#eq:energy}       → <div class="math" id="eq:energy">
$$ x = 1 $$ {#eq:a}

{#eq:a} 归一化条件              → <figure><div class="math">…</div><figcaption>式 1：…</figcaption></figure>
```

### 行内语法

| 语法 | 输出 | 说明 |
|---|---|---|
| `**粗体**` / `__粗体__` | `<strong>` | |
| `***粗斜体***` / `___粗斜体___` | `<strong><em>` | 粗体+斜体 |
| `*斜体*` / `_斜体_` | `<em>` | |
| `~~删除~~` | `<del>` | |
| `~下标~` | `<sub>` | |
| `^上标^` | `<sup>` | |
| `` `代码` `` | `<code>` | |
| `[链接文本](https://x)` | `<a href="https://x">` | |
| `https://裸链接` | `<a href>` | 独立成词的全串 URL 自动链接 |
| `![替代文本](img.png)` | `<img alt>` | |
| `![图](img.png 50%)` | `<img width="50%">` | 宽度：url 后空格 + `N%` |
| `![图](img.png){#fig:1}` | `<img id="fig:1">` | 交叉引用 label（紧跟 url，无空格） |
| `/#ff0000:红色文本:/` | `<span style="color:#ff0000">` | 3 或 6 位 hex 色 |
| `$E = mc^2$` | `<span class="math-inline">` | 行内公式（限同行），KaTeX 渲染 |
| `<b>透传</b>` | 原样输出 | 行内 HTML 透传（本行内需有闭合 `>`） |
| `[^n1]` | `<a href="#fn-1">` | 脚注引用 |

#### 转义（四层，按使用场景）

| 场景 | 转义方式 | 示例 |
|---|---|---|
| 行内语法起始符 | 反斜杠 `\*` `\_` `\~` `` \` `` `\[` `\!` `\@` `\/` `\\` `\$` | `\$5` → `$5` |
| 表达式字符串内 | `\"` `\\`（字符串字面量转义） | `@cite("a\\\"b")` |
| 宏 @use 的值 | **自动**字面转义（值里 md/函数不解析） | `@use("t", { v: "a * b" })` |
| HTML 层 | 正文受 `escapeHtml` 控制；**属性值恒转义**（防注入） | `data-cite-key` 等 |

```md
\$5 与 $x$        → $5 与 <span class="math-inline">x</span>
```

#### 行内公式

```md
质能方程 $E = mc^2$ 是核心
```

- 未闭合的 `$`/`$$` 回退普通文本
- 默认 KaTeX 渲染（`throwOnError: false` 容错，错误公式显示红色提示而非崩溃）
- `mathRenderer` 选项可替换渲染器

---

## 表达式

函数参数是表达式，支持：

| 类别 | 语法 |
|---|---|
| 数字 | `42` `3.14` |
| 字符串 | `"文本"` `'文本'`（转义 `\"` `\\` 等） |
| 布尔 | `true` `false` |
| 数组 | `["a", "b"]` |
| 对象 | `{ key: "value", n: 1 }`（值可为表达式） |
| 属性访问 | `obj.prop` `arr[0]` `a.b[0].c`（可链式；缺失返回 undefined） |
| 变量 | `threshold`（由 `@let` 或 `variables` 选项提供） |
| 函数调用 | `has_cite("doe2020")` `cite("doe2020")`（`@cite("...")` 前缀形式同样可用，两套统一） |
| 一元 | `!x` `-x` |
| 算术 | `+ - * / %` |
| 比较 | `==` `!=` `<` `>` `<=` `>=` |
| 逻辑 | `&&` `||`（短路求值，不触发副作用） |

优先级（高 → 低）：`一元(! -)` → `* / %` → `+ -` → `比较` → `&&` → `||`

```md
@if(1 + 2 * 3 == 7 && !(2 > 3), "成立", "不成立")     →  成立
@if(false && cite("x"), "a", "b")                     →  b（短路：cite 不执行）
```

---

## 内置函数

| 函数 | 说明 |
|---|---|
| `@if(cond, then, else?)` | 条件；`else` 省略输出空 |
| `@not(x)` / `@and(...xs)` / `@or(...xs)` | 逻辑运算 |
| `@set({...})` | 文档内配置（见下方白名单），无输出 |
| `@let("name", value)` | 声明变量（预扫描注册，全文档可见；同名覆盖），无输出 |
| `@plugin("name", "函数体")` | 注册自定义函数（见插件一节），无输出 |
| `@has_cite("key")` | 数据中存在该文献 |
| `@has_term("name")` | 数据中存在该术语 |
| `@cite("key")` | 文献引用，自动编号 `[n]`；支持多 key `@cite("a","b")` → `[1-3]`（连续区间合并）/`[1,3]`（非连续）/author-year `(Doe, 2020a; Smith, 2019)` |
| `@term("name")` | 术语引用（行内高亮） |
| `@ref("label")` | 交叉引用：章节/图/表/公式 |
| `@bibliography()` | 文献表：仅列出被引用的条目 |
| `@glossary()` | 术语表：仅列出被引用的术语 |

### @set 白名单键

```md
@set({ headingNumbering: "1.1", refNumbering: "1" })   # 标题自动编号与 @ref 编号提取
@set({ escapeHtml: false })                            # 关闭转义（透传原始 HTML）
@set({ pretty: true })                                 # 输出换行美化
@set({ data: {...} }) / @set({ variables: {...} })     # 顶层整体覆盖
@set({ terms: {...} }) / @set({ bibliography: {...} }) # 顶层增量合并（多次 @set 按 key 合并）
@set({ captionPrefix: { fig: "Figure" } })             # 图表编号前缀
@set({ citeKeyAttr: "data-ref-id" })                   # 引用元数据属性名（空串关闭）
@set({ termKeyAttr: "data-term-id" })
@set({ refKeyAttr: "data-target" })
@set({ citeStyle: "author-year" })                     # 引用样式
@set({ allowPlugins: false })                          # 关闭插件
```

`@set` 覆盖 API 同名选项，全文档生效（建议放文档开头）。

### @let 与变量

```md
@let("threshold", 5)                      # 值可为任意表达式
@let("score", threshold * 2 + 1)

@if(score > 10, "高分", "低分")           # 全文档可见（声明前也可引用）
```

- 同名覆盖（后者生效）；可与 API `variables` 选项共存（文档内优先）
- `@set` 参数、`@ref` 编号计算、渲染阶段均可引用变量

```md
@theorem("thm:1", "均值定理")      ← 类型：theorem/lemma/definition/remark/example

设 f 连续，则存在 c 使 f(c) 等于均值。   ← 下一段落即定理内容（完整行内语法）

由 @ref("thm:1") 可得               → 定理 1
```

→ `<div class="theorem theorem" id="thm:1"><div class="theorem-label">定理 1 均值定理</div>…</div>`

- 编号共享序列（定理 1、引理 2、定义 3…），前缀按类型（定理/引理/定义/注记/例）
- 内容限单段落；标记行无下一段时降级为普通段落

### 宏/模板（@define + @use）

文档内复用片段（学术写作"定义—引用"模式，机制与 `@let`/`@plugin` 同构）：

```md
@define("card", "**{title}**：{body}")        ← 定义宏（预扫描注册，无输出）

@use("card", { title: "结论", body: "内容" })  →  <strong>结论</strong>：内容
```

- 模板为 **mslang 行内片段**（`**`、`@cite` 等语法生效），占位符 `{key}` 任意字符（含中文）
- 值按字面转义（值里的 `*`/`@cite` 不解析，防注入）；缺占位符键时保留 `{key}` 原文
- 未定义宏输出错误注释；宏跨文档合并可见；值可引用 `@let` 变量

### 注册机制选择（@let / @define / @plugin）

三者都"预扫描注册、无输出、同名覆盖"，按用途选：

| 需求 | 用 | 示例 |
|---|---|---|
| 算个值/存数据 | `@let("n", 42)` | `@if(score > 10, "高", "低")` |
| 参数化文本（含 md 语法） | `@define` + `@use` | 卡片、重复句式 |
| 程序逻辑（返回 HTML） | `@plugin("fn", "JS 函数体")` | 排序、条件拼接 |

要点：`@use` 结果**再按行内语法解析**（模板里可写 `**`、`@cite`）；`@plugin` 结果**原样当 HTML** 输出。需要 md 语法 → 宏，需要真逻辑 → 插件。

---

## 数据（data）

`data` 提供文献与术语库（API 选项或 `@set` 注入）：

```javascript
render(src, {
  data: {
    bibliography: {
      doe2020: {                          // key = @cite 引用名
        authors: 'Doe, J.',
        year: 2020,
        title: 'A Study',
        journal: 'JML',
        key: 'doi:10.1000/xyz',           // 可选：data 属性输出用（与引用名解耦）
      },
      smith2019: 'Smith (2019) Work',     // 字符串简写：直接作为显示文本
    },
    terms: {
      词干提取: 'Stemming',               // 字符串：label 简写
      嵌入: { label: 'Embedding', url: 'https://x', desc: '向量表示', key: 'emb' },
    },
  },
});
```

### 引用样式（citeStyle）

```javascript
render(src, { citeStyle: 'author-year' });   // 或 @set({ citeStyle: "author-year" })
```

| 样式 | 正文 | 文献表 |
|---|---|---|
| `numeric`（默认） | `[1]` 上标链接 | 编号 `<ol>`（引用顺序） |
| `author-year` | `(Doe, J., 2020a)` | 按作者+年份排序 `<ul>`（id 仍对应引用锚点） |
| `author` | `(Doe, J.)` | 同 author-year 排序 |

- 同年同作者自动消歧 `a/b/c`（按引用顺序）
- 缺 `authors` 的条目回退数字编号；字符串简写条目不受影响

### 术语表

```md
@term("词干提取") 与 @term("嵌入")

@glossary()     → <ul class="glossary"><li id="term-1"><a href="…">Embedding — 向量表示</a></li>…
```

- 仅列出**被引用过**的术语，按首次出现顺序；`desc` 可选（`label — desc`）；`url` 可链接

---

## 渲染选项

`render(source, options)` 完整选项（通道：构造器 = 仅构造时生效；渲染 = 每次渲染；`@set` = 可文档内配置）：

| 选项 | 默认 | 通道 | 说明 |
|---|---|---|---|
| `async` | `false` | 渲染 | 异步渲染，返回 `Promise<string>`（支持返回 Promise 的自定义函数） |
| `blocks` | `false` | 渲染 | 块级渲染，返回 `{ html, blockHashes }`（见块级编辑） |
| `data` | `{}` | 渲染 + @set | 文献/术语数据 |
| `variables` | `{}` | 渲染 + @set | 变量表 |
| `functions` | `{}` | 构造器 | 自定义函数表（`{ name: fn }`） |
| `wrapperClass` | `'mslang'` | 渲染 | 外层 div class |
| `wrapperId` | `''` | 渲染 | 外层 div id |
| `headingNumbering` | `''` | 渲染 + @set | 标题自动编号（`'1.1'` → 1.1、1.1.1；`'1'` → 1、1.1；`'一'` → 中文） |
| `refNumbering` | `''` | 渲染 + @set | `@ref` 显示编号提取（与标题文本匹配） |
| `captionPrefix` | `{fig:'图',tbl:'表',eq:'式',thm:{...}}` | 渲染 + @set | 编号前缀；`thm` 按类型（定理/引理/定义/注记/例），可 `@set({captionPrefix:{thm:{theorem:"Theorem"}}})` 部分覆盖 |
| `citeKeyAttr` | `'data-cite-key'` | 渲染 + @set | 引用元数据属性名（空串关闭） |
| `termKeyAttr` | `'data-term-key'` | 渲染 + @set | 术语元数据属性名 |
| `refKeyAttr` | `'data-ref-label'` | 渲染 + @set | 交叉引用元数据属性名 |
| `citeStyle` | `'numeric'` | 渲染 + @set | 引用样式（numeric/author-year/author） |
| `allowPlugins` | `true` | 渲染 + @set | 允许 `@plugin` 文档内插件 |
| `escapeHtml` | `true` | 构造器 + @set | 转义正文特殊字符（属性值恒转义，不受此影响） |
| `pretty` | `false` | 构造器 + @set | 输出换行美化 |
| `check` | `false` | 渲染 | 引用完整性检查：返回 `{ html, issues }`（见下） |
| `bibStyle` | `'default'` | 渲染 + @set | 文献表条目样式：`'default'` / `'gbt7714'`（近似 GB/T 7714 点分隔） |
| `mathRenderer` | 内置 KaTeX | 渲染 | 公式渲染器 `(src, inline) => html`（函数，不可 @set） |
| `mathFontsPath` | CDN | 渲染 | KaTeX 字体本地托管路径（`'fonts/'`） |
| `codeRenderer` | 转义透传 | 渲染 | mermaid 渲染器 `(source, language) => html`（函数，不可 @set） |

### 引用完整性检查（check）

AI 生成文档后自查引用是否有缺口（缺失仍正常渲染占位，不抛错）：

```javascript
import { render, llmReport, toJSON } from 'mslang';

const { html, issues } = render(source, { data, check: true });
// issues: [{ type: 'missing_cite', key: 'doe2020', count: 2, block: 3 }, ...]
//   type: missing_cite | missing_term | missing_ref | missing_footnote
//         | duplicate_label | orphan_caption | missing_include | missing_part
//   count: 同一 key 出现次数（按 type+key 去重）
//   block: 首次出现的块索引（AI 可直接定位修复）

// 喂回 LLM 自查：issues → 自然语言文本
const report = llmReport(issues);
// "发现 2 类问题：
//  - 块 3：引用了不存在的文献「doe2020」（出现 2 次）
//  - 块 5：孤立 caption（未归并到目标块）「fig:2」"

// 结构化 AST（LLM 读取生成结果结构）：节点 → plain object，type 为节点类名
const tree = toJSON(new Parser().parseText(source));
```

- 检测范围：`@cite`/`@term`/`@ref`（含嵌套在表达式 `cite("k")` 中的）与 `[^n]` 脚注引用、重复标签（`duplicate_label`）、孤立 caption（`orphan_caption`）、`@include` 加载失败（`missing_include`）/ part 缺失（`missing_part`）
- 有数据/定义时无对应 issue；`blocks`/`async` 模式同样支持
- **AI 工作台闭环**：`render({check:true})` 定位 → `llmReport` 文本化喂 LLM → LLM 修复 → 重渲验证

---

## 异步渲染

自定义函数返回 Promise 时需异步渲染（如浏览器 fetch、数据库查询）：

```javascript
const html = await render('标题：@fetch_title("paper1")', {
  async: true,
  functions: { fetch_title: async (key) => `<b>${key}</b>` },
});
```

- 多个异步函数并行等待；reject 时输出错误注释而非抛错
- 同步渲染遇到返回 Promise 的函数会输出提示注释：`<!-- mslang: async function @name 需使用 renderAsync() -->`

---

## 插件（文档内自定义函数）

在 md 里直接写 JS 注册可复用函数（**默认开启**）：

```md
@plugin("double", "(x, kwargs) => x * 2")     // new Function 编译，签名与内置一致 (...args, kwargs)
@double(21)                                    →  42

@plugin("ul", `(items) => items.map(i => "<li>" + i + "</li>").join("")`)
@ul(["a", "b"])                                →  <li>a</li><li>b</li>

@plugin("fetch", `async (u) => "<b>" + u + "</b>"`)   // 异步插件需 { async: true }
```

- 预扫描阶段注册（与 `@set`/`@let` 同机制）：**全文档可见、跨文档合并可用**
- 可覆盖内置/宿主同名函数；同 body 编译缓存；编译失败不崩溃（调用输出错误注释）
- 关闭：`allowPlugins: false`（API 或 `@set`）
- ⚠️ **安全提示**：插件函数体是真实 JS（`new Function` 全局作用域），文档即代码——仅在可信文档上开启
- 函数体无法捕获文档内 `@let` 变量（全局作用域），请通过参数/kwargs 传值

---

## 跨文档合并

`source` 传数组自动合并（字符串自动解析；`Document` 直接使用）：

```javascript
const html = render(['引言.md', '方法.md', '参考文献.md'], { data: {...} });
```

- 编号（cite/图/表/节/公式）**跨文档连续**，顺序即编号顺序
- 交叉引用（`@ref`）可跨文档
- `@set`/`@let`/`@plugin` 全局生效（预扫描按文档顺序执行）
- 脚注跨文档重编号；同名脚注后者覆盖

---

## 跨文档引用（@part + @include）

笔记 → 汇总：在笔记文档中**定义可引用区间**，在汇总文档中**引用片段**（动态 loader，新增文档零宿主改动）。

### 定义侧（笔记文档）

```msl
@part("h1", "LLM 幻觉率笔记")

> 原文：GPT-4 幻觉率 27%（Doe, 2024）

我的分析：27% 明显偏高。

@end
```

- `@part("id", "标题")` 独占一行（后接空行）= 区间开始；`@end` 独占一行（可紧贴正文） = 结束
- 区间可嵌套（`@part` 内可再 `@part`）
- 笔记独立渲染时 = 带锚点章节（`<section class="part" id="h1">` + `##` 标题）；`@end` 不残留
- `@ref("h1")` 可交叉引用该部分（同文档或展开后的汇总文档）
- `@end` 前的内容保留（紧贴写法 `正文\n@end` 不会丢内容）；孤立 `@end`（无匹配 part）被保留显示

### 引用侧（汇总文档）

```msl
# 汇总分析

@include("notes/a.msl", "h1")
@include("notes/b.msl", "p3")
```

- 展开进汇总文档后**统一编号**（图/表/式连续）、`@ref` 指向展开内容、`duplicate_label` 冲突检测——全部自动生效
- **剥离块级 `@set` 行**（配置防污染，笔记设置不影响汇总）；`@let`/`@define` 保留（内容依赖）
- 嵌套展开（include 的目标文档里可再 include）；循环引用自动检测（注释 + 跳过）
- 同次渲染中重复 include 同一文件走缓存

### 数据通道（宿主注册一次，动态发现）

```javascript
// 同步 loader：返回 string（新增文档 = 新建文件 + 在汇总里加一行引用，零代码改动）
render(outline, { include: (path) => workspace.getDoc(path) });

// 异步 loader：返回 Promise，需 async: true
const html = await render(outline, {
  include: async (path) => (await fetch('/notes/' + path)).text(),
  async: true,
});

// BlockEditor 支持同步 loader（构造时展开）；异步 loader 请走 render async:true
```

### 容错与校验

| 情况 | 处理 |
|---|---|
| 文件缺失（loader 抛错/返回空） | `missing_include` issue + 占位注释 |
| part id 不存在 | `missing_part` issue + 占位注释 |
| 循环引用 A→B→A | 占位注释 + 跳过 |
| `@include` 未指定 part id | 占位注释（整文档合并请用 `render([...])`） |

---

## 块级编辑

用于块级编辑器（类 Notion）：只更新变化的块 DOM。**首选 `BlockEditor` 封装**（单一接口，状态/降级内置）。

### BlockEditor（推荐）

```javascript
import { BlockEditor } from 'mslang';

const ed = new BlockEditor(source, { data, headingNumbering: '1' });

// ① 初始渲染：切分每块 html + 脚注区（已剥离 wrapper），宿主直接铺 DOM
const { blocks, footnotes } = ed.render();
// blocks = { 0: '<h1>…</h1>', 1: '<p>…</p>', ... }   footnotes = '<hr>…'

// ② 编辑块 i（内部：拼源码 → 全量重渲 → diff → 局部/全量决策）
const r = ed.update(3, '新文本');
// r.changed = [3]（或 [1,4] 编号传播）；r.blocks = { 3: '<p>…</p>' }
// r.full = true 时 r.blocks 为全量（块数变化/变化多 > 3 时降级）
// r.blocks.footnotes 存在 = 脚注区也变化

// ③ 脚注定义行不属于任何块：用 updateSource 逃生口改全文
const r2 = ed.updateSource(source.replace('[^n]: 旧', '[^n]: 新'));

// ④ 数据更新后重渲
ed.setOptions({ data: newData });
ed.render();
```

- 内部状态机（source/hashes/块区间）自动同步，宿主无需维护
- 块 raw 含块间空行分隔，编辑时自动保留（防块合并）；宿主存回文本原样即可
- 降级规则：块数变化或变化块 > 3 → `full: true` 全量重建

### 底层说明（BlockEditor 内部机制）

`render(source, { blocks: true })` 输出含 `<!--mslang:N-->` 哨兵的 html 与 `blockHashes`（块源 + 编号前缀快照 + 渲染依赖哈希）。BlockEditor 内部基于此实现切分与差异更新；需要自定义流程的宿主可直接用该输出（变化检测逻辑参考 `src/renderer.js` 的 `diffBlocks`）。
- 编号依赖自动传播：块 i 加图 → 块 i..N 的哈希全变（哈希含编号前缀快照 fig/tbl/sec/eq/cite/term/thm 计数）
- 渲染依赖自动传播：`@let` 变量值、`@define` 模板、`data` 条目内容变化 → **引用它们的块**哈希变（按块收集依赖，非全量）
- 纯文本编辑只影响 1 块；默认 `render` 无哨兵（零回归）
- 代码高亮语言：`javascript typescript python java c cpp go rust bash json sql xml css markdown kotlin swift ruby php perl yaml dockerfile diff`


---

## 引用元数据（工作台交互）

`@cite`/`@term`/`@ref` 输出携带 data 属性（点击证据 → 工作台定位文献库/术语库）：

```html
<a href="#cite-1" id="ref-cite-1" data-cite-key="doe2020" data-cite-index="0">[1]</a>
<a href="https://x" data-term-key="emb">Embedding</a>
<a href="#sec:intro" data-ref-label="sec:intro" data-ref-kind="sec">引言</a>
```

- 属性名可配置（`@set` 或 API 选项，空串关闭）：`citeKeyAttr` / `termKeyAttr` / `refKeyAttr`
- `refKeyAttr` 附带 `data-ref-kind`（sec/fig/tbl/eq）
- 属性值**恒转义**（`escapeHtml: false` 时也防注入）

---

## API 参考

```javascript
import { render, Parser, dumpAST, BlockEditor, toJSON, llmReport } from 'mslang';
```

### `render(source, options)`

唯一入口。`source` 为字符串渲染、数组自动合并；返回 `string | Promise<string> | { html, blockHashes }`（由 `async`/`blocks` 配置决定）。完整选项见[渲染选项](#渲染选项)。

### `toJSON(node)` / `llmReport(issues)`

AI 工作台辅助：`toJSON` 将 AST 转为 plain object（`type` 为节点类名，剔除内部字段）；`llmReport` 将 check issues 转为自然语言自查文本（见[引用完整性检查](#引用完整性检查check)）。

### `Parser`

```javascript
const doc = new Parser().parseText(source);   // 字符串 → Document（块带 startPos/endPos/raw）
const doc2 = new Parser().parse(tokens);      // Token 流 → Document（需自行 Lexer）
```

### `dumpAST(node)`

打印 AST 树形结构（调试用）。

### 错误容错

表达式语法错误、未知函数、插件编译失败等一律输出 HTML 注释而非抛错（AI 生成场景友好）：

```html
<!-- mslang: 参数解析错误 @if: ... -->
<!-- mslang: unknown function @foo -->
<!-- mslang: function @foo error: ... -->
```

---

## 测试与构建

```bash
npm test        # node:test 运行 test/ 下 87 项测试（零新依赖）
npm run build   # esbuild 构建 dist/（esm / iife / iife.min）
```

---

## 设计原则

- **显式优于隐式**：caption 需 `{#label}` 显式声明；`@ref` 显示"标题全文/编号"由配置显式决定
- **容错**：表达式错误、未知函数输出 HTML 注释而非崩溃（AI 生成场景友好）
- **能自动处理的绝不要用户手动处理**：数组自动合并、编号自动连续、KaTeX/hljs 开箱即用、块级哈希自动传播
- **唯一入口**：async/合并/块级均为配置项；低级 API（Lexer/节点类/表达式求值）不导出
- **编辑层与出图层分离**：mslang 负责写作/交互（动态、容错、AST 可编程），最终 PDF 可由 `mslang → .typ` 转换链路交给 Typst 原生编译
