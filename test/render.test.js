// renderer 渲染测试：基础语法、表达式、内置函数、配置、异步
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, HTMLRenderer, diffBlocks, Parser } from '../src/index.js';

const data = {
  bibliography: {
    doe2020: { number: 1, authors: 'Doe', year: 2020, title: 'Paper', journal: 'JML' },
    smith2019: { number: 2, authors: 'Smith', year: 2019, title: 'Work', journal: 'ACL' },
  },
  terms: { '词干提取': { label: 'Stemming', url: 'https://stem.example' } },
};

test('基础块级渲染', () => {
  assert.match(render('# 标题'), /<h1>标题<\/h1>/);
  assert.match(render('---'), /<hr>/);
  assert.match(render('> 引用'), /<blockquote>\n引用\n<\/blockquote>/);
});

test('行内语法', () => {
  assert.match(render('**粗** *斜* ~删~ `码`'), /<strong>粗<\/strong> <em>斜<\/em> <sub>删<\/sub> <code>码<\/code>/);
});

test('wrapper 默认 class', () => {
  assert.match(render('文本'), /^<div class="mslang">/);
});

test('表达式逻辑', () => {
  assert.match(render('@if(1+2*3 == 7 && !(2>3), "ok", "no")'), /ok/);
  assert.match(render('@if(false || true, "a", "b")'), /a/);
});

test('表达式短路不触发副作用', () => {
  // false && cite("x")：cite 不求值，不报错
  const h = render('@if(false && cite("x"), "a", "b")', { data });
  assert.match(h, /b/);
});

test('数组与对象字面量', () => {
  assert.match(render('@if(true, ["a", "b"], [])'), /ab/);
  // 对象值非字符串/数组，String 化输出
  const h = render('@if(true, {a: 1}, {})');
  assert.ok(h.includes('[object Object]'));
});

test('cite 编号与文献表', () => {
  const h = render('@cite("doe2020") 与 @cite("smith2019")\n\n@bibliography()', { data });
  assert.match(h, /href="#cite-1"[^>]*>\[1\]<\/a>/);
  assert.match(h, /href="#cite-2"[^>]*>\[2\]<\/a>/);
  assert.match(h, /<li id="cite-1">Doe \(2020\) Paper JML<\/li>/);
});

test('缺失文献占位', () => {
  assert.match(render('@cite("nope")', { data }), /\[nope\?\]/);
});

test('term 渲染（对象带 url）', () => {
  const h = render('@term("词干提取")', { data });
  assert.match(h, /<a href="https:\/\/stem\.example"[^>]*><span class="term">Stemming<\/span><\/a>/);
});

test('term 字符串简写', () => {
  const h = render('@term("缩写")', { data: { terms: { 缩写: '全称' } } });
  assert.match(h, /<span class="term"[^>]*>全称<\/span>/);
});

test('ref 章节（默认标题全文）', () => {
  const h = render('## 方法 {#sec:m}\n\n见 @ref("sec:m")');
  assert.match(h, /href="#sec:m"[^>]*>方法<\/a>/);
});

test('ref 图/表编号', () => {
  const h = render('![图](/a.png){#fig:1}\n\n见 @ref("fig:1")');
  assert.match(h, /href="#fig:1"[^>]*>图 1<\/a>/);
});

test('标题自动编号', () => {
  const h = render('# 一\n\n## 二\n\n### 三', { headingNumbering: '1.1' });
  assert.match(h, /<h1>1 一<\/h1>/);
  assert.match(h, /<h2>1\.1 二<\/h2>/);
  assert.match(h, /<h3>1\.1\.1 三<\/h3>/);
});

test('图片 caption 渲染 figure', () => {
  const h = render('![图A](/a.png){#fig:1}\n\n{#fig:1} 装置');
  assert.match(h, /<figure id="fig:1">\n<img src="\/a\.png" alt="图A" referrerpolicy="no-referrer">\n<figcaption>图 1：装置<\/figcaption>\n<\/figure>/);
});

test('表格 caption 在表头上方', () => {
  const h = render('| x |{#tbl:t}|\n|---|\n| 1 |\n\n{#tbl:t} 数据');
  assert.match(h, /<table id="tbl:t">\n<caption>表 1：数据<\/caption>\n<thead>/);
});

test('captionPrefix @set 配置', () => {
  const h = render('@set({ captionPrefix: { fig: "Figure" } })\n\n![图](/a.png){#fig:1}\n\n{#fig:1} 装置\n\n见 @ref("fig:1")');
  assert.match(h, /<figcaption>Figure 1：装置<\/figcaption>/);
  assert.match(h, />Figure 1<\/a>/);
});

test('引用元数据默认属性', () => {
  const h = render('@cite("doe2020") @term("词干提取")', { data });
  assert.match(h, /data-cite-key="doe2020" data-cite-index="0"/);
  assert.match(h, /data-term-key="词干提取"/);
});

test('引用元数据自定义属性名与关闭', () => {
  const h = render('@cite("doe2020")', { data, citeKeyAttr: 'data-doc' });
  assert.match(h, /data-doc="doe2020"/);
  const h2 = render('@cite("doe2020")', { data, citeKeyAttr: '' });
  assert.ok(!h2.includes('data-cite-key'));
});

test('引用元数据值恒转义', () => {
  const h = render('@cite("a\\"b")', {
    data: { bibliography: { 'a"b': { number: 1 } } }, escapeHtml: false,
  });
  assert.match(h, /data-cite-key="a&quot;b"/);
});

test('条目 key 字段：data 属性输出条目 key（与引用名解耦）', () => {
  // 文献条目 key 字段（如数据库主键）
  const h = render('@cite("doe2020")', {
    data: { bibliography: { doe2020: { number: 1, key: 'uuid-abc-123' } } },
  });
  assert.match(h, /data-cite-key="uuid-abc-123"/);
  // 术语条目 key 字段
  const h2 = render('@term("词干提取")', {
    data: { terms: { 词干提取: { label: 'Stemming', key: 'wqdwqr32r234' } } },
  });
  assert.match(h2, /data-term-key="wqdwqr32r234"/);
});

test('条目无 key 字段时回退引用名', () => {
  const h = render('@cite("doe2020") @term("词干提取")', {
    data: {
      bibliography: { doe2020: { number: 1 } },
      terms: { 词干提取: '词干提取 (Stemming)' },
    },
  });
  assert.match(h, /data-cite-key="doe2020"/);
  assert.match(h, /data-term-key="词干提取"/);
});

test('公式：行内与块级容器（内置 KaTeX 渲染）', () => {
  const h = render('质能方程 $E = mc^2$');
  assert.match(h, /<span class="math-inline"><span class="katex">/);
  assert.match(h, /<annotation encoding="application\/x-tex">E = mc\^2<\/annotation>/);
  const b = render('$$ \\int_0^1 x dx $$');
  assert.match(b, /<div class="math"><span class="katex-display">/);
  assert.match(b, /<annotation encoding="application\/x-tex"> \\int_0\^1 x dx <\/annotation>/);
});

test('公式：块级 label、编号与 @ref', () => {
  const h = render('$$ E = mc^2 $$ {#eq:energy}\n\n见 @ref("eq:energy")');
  assert.match(h, /<div class="math" id="eq:energy">/);
  assert.match(h, />式 1<\/a>/);
});

test('公式：caption 归并渲染 figure', () => {
  const h = render('$$ x = 1 $$ {#eq:a}\n\n{#eq:a} 归一化条件');
  assert.match(h, /<figure id="eq:a">/);
  assert.match(h, /<figcaption>式 1：归一化条件<\/figcaption>/);
});

test('公式：未闭合回退普通文本', () => {
  assert.match(render('价格是 $5 美元'), /<p>价格是 \$5 美元<\/p>/);
  assert.match(render('$$ 未闭合'), /\$\$ 未闭合/);
});

test('公式：\\$ 转义美元符号', () => {
  const h = render('\\$5 与 $x$');
  assert.match(h, /<p>\$5 与 <span class="math-inline"><span class="katex">/);
});

test('公式：mathRenderer 钩子', () => {
  const h = render('$x^2$ 与 $$ y $$', {
    mathRenderer: (src, inline) => `[[${inline ? 'i' : 'b'}:${src}]]`,
  });
  assert.match(h, /<span class="math-inline">\[\[i:x\^2\]\]<\/span>/);
  assert.match(h, /<div class="math">\[\[b: y \]\]<\/div>/);
});

test('公式：内容默认转义防注入', () => {
  assert.match(render('$a < b$'), /a &lt; b/);
});

test('引用样式：author-year 与 author', () => {
  const data = {
    bibliography: {
      doe2020: { authors: 'Doe, J.', year: 2020, title: 'A', journal: 'JML' },
      smith2020: { authors: 'Smith, A.', year: 2020, title: 'B', journal: 'ACL' },
    },
  };
  const doc = '@cite("doe2020") @cite("smith2020")\n\n@bibliography()';
  // author-year：正文 (Doe, J., 2020)，文献表按作者排序的 ul
  const h = render(doc, { data, citeStyle: 'author-year' });
  assert.match(h, />\(Doe, J\., 2020\)<\/a>/);
  assert.match(h, /<ul class="bibliography">/);
  assert.ok(h.indexOf('>Doe, J. (2020) A JML</li>') < h.indexOf('>Smith, A. (2020) B ACL</li>'));
  // author：无年份
  const h2 = render(doc, { data, citeStyle: 'author' });
  assert.match(h2, />\(Doe, J\.\)<\/a>/);
  // @set 配置
  const h3 = render('@set({ citeStyle: "author-year" })\n\n@cite("doe2020")', { data });
  assert.match(h3, />\(Doe, J\., 2020\)<\/a>/);
});

test('引用样式：同年同作者消歧 a/b', () => {
  const data = {
    bibliography: {
      a1: { authors: 'Lee', year: 2021, title: 'X' },
      a2: { authors: 'Lee', year: 2021, title: 'Y' },
    },
  };
  const h = render('@cite("a1") @cite("a2")\n\n@bibliography()', { data, citeStyle: 'author-year' });
  assert.match(h, />\(Lee, 2021a\)<\/a>/);
  assert.match(h, />\(Lee, 2021b\)<\/a>/);
});

test('术语表：@glossary 按引用顺序列出（label — desc，url 链接）', () => {
  const h = render('@term("a") 与 @term("b")\n\n@glossary()', {
    data: { terms: { a: { label: 'Alpha', desc: '第一个', url: 'https://x' }, b: 'Beta' } },
  });
  assert.match(h, /<ul class="glossary">/);
  assert.match(h, /<li id="term-1"><a href="https:\/\/x">Alpha — 第一个<\/a><\/li>/);
  assert.match(h, /<li id="term-2">Beta<\/li>/);
  // 未被引用的术语不列出
  const h2 = render('@glossary()', { data: { terms: { c: 'C' } } });
  assert.ok(!h2.includes('class="glossary"'));
});

test('代码高亮：hljs 渲染与内联 CSS', () => {
  const h = render('```js\nconst a = 1;\n```');
  assert.match(h, /<code class="hljs language-js">/);
  assert.match(h, /<span class="hljs-keyword">const<\/span>/);
  assert.match(h, /<style>/); // github 主题内联
  // 未知语言不高亮
  assert.match(render('```nolang\nx\n```'), /<code>x<\/code>/);
  // 高亮转义安全（escapeHtml:false 下也安全）
  const h2 = render('```html\n<b>t</b>\n```', { escapeHtml: false });
  assert.ok(h2.includes('&lt;') && !h2.includes('<b>t</b>'));
});

test('流程图：mermaid 代码块渲染 div/figure/caption', () => {
  const flow = '```mermaid {#fig:flow}\ngraph TD\n  A[采集] --> B{清洗}\n```';
  // 无 label：仅 div.mermaid
  const plain = render('```mermaid\ngraph TD\n  A --> B\n```');
  assert.match(plain, /<div class="mermaid">graph TD/);
  assert.ok(!plain.includes('<figure'));
  // 带 label + caption：figure + figcaption
  const h = render(`${flow}\n\n{#fig:flow} 数据采集流程`);
  assert.match(h, /<figure id="fig:flow">/);
  assert.match(h, /<figcaption>图 1：数据采集流程<\/figcaption>/);
  // @ref 编号
  assert.match(render(`${flow}\n\n见 @ref("fig:flow")`), />图 1<\/a>/);
});

test('流程图：fig 编号与图片共享且按文档顺序', () => {
  const flow = '```mermaid {#fig:flow}\ngraph TD\n  A --> B\n```';
  const h = render('![图A](/a.png){#fig:a}\n\n' + flow + '\n\n![图B](/b.png){#fig:b}\n\n@ref("fig:a") @ref("fig:flow") @ref("fig:b")');
  assert.match(h, />图 1<\/a> <a href="#fig:flow"[^>]*>图 2<\/a> <a href="#fig:b"[^>]*>图 3<\/a>/);
});

test('流程图：codeRenderer 钩子与普通代码块隔离', () => {
  const flow = '```mermaid {#fig:flow}\ngraph TD\n  A --> B\n```';
  const h = render(flow, { codeRenderer: (code, lang) => `<svg>${lang}</svg>` });
  assert.match(h, /<div class="mermaid"><svg>mermaid<\/svg><\/div>/);
  // 普通代码块不受 codeRenderer 影响（js 现在走内置高亮）
  const js = render('```js\nx\n```', { codeRenderer: () => 'SVG' });
  assert.match(js, /<code class="hljs language-js">x<\/code>/);
  // js fence 的 label 不参与 fig 编号
  const jsLabeled = render('```js {#x}\ny\n```');
  assert.ok(!jsLabeled.includes('id="x"'));
});

test('公式：文档自动内联 KaTeX CSS（wrapper 外）', () => {
  const h = render('质能方程 $E = mc^2$');
  assert.match(h, /^<style>@font-face/); // style 位于输出开头
  assert.match(h, /\.katex-display/); // CSS 内容已内联
  // 无公式文档不内联
  assert.ok(!render('普通文本').includes('<style>'));
  // 自定义 mathRenderer 时不内联（渲染器自管样式）
  assert.ok(!render('$x$', { mathRenderer: (s, i) => 'X' }).includes('<style>'));
});

test('公式：字体 URL 重写为 CDN（默认）与 mathFontsPath（本地托管）', () => {
  const h = render('$x$');
  assert.match(h, /url\(https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[\d.]+\/dist\/fonts\//);
  // 本地托管：mathFontsPath 覆盖
  const h2 = render('$x$', { mathFontsPath: '/assets/katex-fonts/' });
  assert.match(h2, /url\(\/assets\/katex-fonts\//);
  assert.ok(!h2.includes('jsdelivr'));
});

test('引用：@cite 多 key 区间合并与 author-year 共享括号', () => {
  const data = {
    bibliography: {
      a: {}, b: {}, c: {}, d: {},
      x: { authors: 'Doe, J.', year: 2020 },
      y: { authors: 'Smith, A.', year: 2019 },
    },
  };
  let h = render('@cite("b","c","d")', { data });
  assert.match(h, /<sup>\[<a href="#cite-1"[^>]*data-cite-key="b"[^>]*>1<\/a>-<a href="#cite-3"[^>]*data-cite-key="d"[^>]*>3<\/a>\]<\/sup>/);
  h = render('@cite("x") @cite("a") @cite("y") @cite("a","c")', { data });
  assert.match(h, /<sup>\[<a href="#cite-2"[^>]*data-cite-key="a"[^>]*>2<\/a>,<a href="#cite-4"[^>]*data-cite-key="c"[^>]*>4<\/a>\]<\/sup>/);
  h = render('@cite("x","y")', { data, citeStyle: 'author-year' });
  assert.match(h, /\(<a href="#cite-1"[^>]*>Doe, J\., 2020<\/a>; <a href="#cite-2"[^>]*>Smith, A\., 2019<\/a>\)/);
  h = render('@cite("a","zz")', { data });
  assert.match(h, /1<\/a>,zz\?\]/);
});

test('表格：单元格支持行内语法', () => {
  const data = { bibliography: { a: {} } };
  let h = render('| **粗** | ~下~ |\n|---|---|');
  assert.match(h, /<th><strong>粗<\/strong><\/th>/);
  assert.match(h, /<th><sub>下<\/sub><\/th>/);
  h = render('| 方法 | 引用 |\n|---|---|\n| A | @cite("a") |', { data });
  assert.match(h, /<td><sup><a href="#cite-1"/);
  h = render('| x | y |{#tbl:t}|\n|---|---|\n| 1 | 2 |\n\n{#tbl:t} 数据表');
  assert.match(h, /<table id="tbl:t">/);
});

test('check：引用完整性检查', () => {
  const r = render('@cite("x") @cite("x") @cite("y")\n\n@term("无")\n\n见 @ref("no-such")\n\n注[^n1]', { check: true });
  assert.strictEqual(typeof r.html, 'string');
  const find = (type, key) => r.issues.find(i => i.type === type && i.key === key);
  assert.deepStrictEqual(find('missing_cite', 'x'), { type: 'missing_cite', key: 'x', count: 2 });
  assert.deepStrictEqual(find('missing_cite', 'y'), { type: 'missing_cite', key: 'y', count: 1 });
  assert.deepStrictEqual(find('missing_term', '无'), { type: 'missing_term', key: '无', count: 1 });
  assert.deepStrictEqual(find('missing_ref', 'no-such'), { type: 'missing_ref', key: 'no-such', count: 1 });
  assert.deepStrictEqual(find('missing_footnote', 'n1'), { type: 'missing_footnote', key: 'n1', count: 1 });
  const ok = render('@cite("a")\n\n![图](/a.png){#fig:1}\n\n见 @ref("fig:1")\n\n注[^n1]\n\n[^n1]: 定义', {
    data: { bibliography: { a: {} } }, check: true,
  });
  assert.strictEqual(ok.issues.length, 0);
});

test('注释：行首 % 透明丢弃', () => {
  assert.ok(!render('% 注释\n\n正文').includes('注释'));
  assert.match(render('甲\n% 注释\n乙'), /甲<br>乙/);
  assert.match(render('```js\n// 100% done\n```'), /100% done/);
  assert.match(render('折扣 50%'), /折扣 50%/);
});

test('粗斜体 *** 与表达式属性访问', () => {
  assert.match(render('***粗斜体*** 与 ___粗斜___'), /<strong><em>粗斜体<\/em><\/strong>.*<strong><em>粗斜<\/em><\/strong>/);
  assert.match(render('@if(true, o.name, "x")', { variables: { o: { name: 'Alice' } } }), /Alice/);
  assert.match(render('@if(true, a.b[0].c, "x")', { variables: { a: { b: [{ c: 42 }] } } }), /42/);
  assert.match(render('@if(true, xs[1], "x")', { variables: { xs: [10, 20] } }), /20/);
});

test('代码高亮扩展语言', () => {
  assert.match(render('```kotlin\nfun main() {}\n```'), /language-kotlin/);
  assert.match(render('```yaml\nk: v\n```'), /language-yaml/);
  assert.match(render('```diff\n+ add\n```'), /language-diff/);
});

test('块级编辑闭环：renderBlock 与 diffBlocks', () => {
  const doc = '# 一\n\n第二段\n\n## 二\n\n![图](/a.png){#fig:1}';
  const r = new HTMLRenderer();
  assert.strictEqual(r.renderBlock(doc, 0), '<h1>一</h1>\n');
  assert.strictEqual(r.renderBlock(doc, 2), '<h2>二</h2>\n');
  assert.match(r.renderBlock(doc, 2, { headingNumbering: '1' }), /1\.1 二/);
  assert.match(r.renderBlock(doc, 3), /id="fig:1"/);
  assert.strictEqual(r.renderBlock(doc, 99), '');
  assert.strictEqual(r.renderBlock(new Parser().parseText('# x'), 0), '<h1>x</h1>\n');
  assert.deepStrictEqual(diffBlocks({ 0: 'a', 1: 'b' }, { 0: 'a', 1: 'B' }), [1]);
  assert.deepStrictEqual(diffBlocks({ 0: 'a' }, { 0: 'a' }), []);
  const before = render('甲\n\n乙', { blocks: true });
  const after = render('甲\n\n改乙', { blocks: true });
  assert.strictEqual(diffBlocks(before.blockHashes, after.blockHashes).length, 1);
});

test('文献样式：bibStyle gbt7714', () => {
  const data = { bibliography: { d: { authors: 'Doe, J.', year: 2020, title: 'A Study', journal: 'JML' } } };
  assert.match(render('@cite("d")\n\n@bibliography()', { data }), /Doe, J\. \(2020\) A Study JML/);
  assert.match(render('@cite("d")\n\n@bibliography()', { data, bibStyle: 'gbt7714' }), /Doe, J\. A Study\. JML, 2020\./);
  assert.match(render('@set({ bibStyle: "gbt7714" })\n\n@cite("d")\n\n@bibliography()', { data }), /JML, 2020\./);
});

test('定理环境：@theorem/@lemma/@definition', () => {
  let h = render('@theorem("thm:1", "均值定理")\n\n设 f 连续');
  assert.match(h, /<div class="theorem theorem" id="thm:1">/);
  assert.match(h, /定理 1 均值定理/);
  h = render('@theorem("t1")\n\nA\n\n@lemma("l1")\n\nB\n\n@definition("d1")\n\nC');
  assert.match(h, /定理 1.*引理 2.*定义 3/s);
  h = render('@theorem("thm:1")\n\nA\n\n由 @ref("thm:1") 可得');
  assert.match(h, />定理 1<\/a>/);
  h = render('@theorem("t1", "见 @cite(\\\"a\\\")")\n\n内容', { data: { bibliography: { a: {} } } });
  assert.match(h, /href="#cite-1"/);
});

test('宏/模板：@define + @use', () => {
  let h = render('@define("card", "**{title}**：{body}")\n\n@use("card", { title: "结论", body: "内容" })');
  assert.match(h, /<strong>结论<\/strong>：内容/);
  h = render('@define("t", "a **{x}** b")\n\n@use("t", { x: "1 * 2" })');
  assert.match(h, /a <strong>1 \* 2<\/strong> b/); // 值字面，模板 md 生效
  h = render('@define("t", "x={a} y={b}")\n\n@use("t", { a: "1" })');
  assert.match(h, /x=1 y=\{b\}/); // 缺键保留占位符
  h = render('@define("t", "hello")');
  assert.ok(!h.includes('hello')); // define 无输出
  h = render('@use("nope", {})');
  assert.match(h, /undefined macro/);
  h = render('@define("t", "score={s}")\n\n@let("n", 42)\n\n@use("t", { s: n })');
  assert.match(h, /score=42/); // 值用变量
  h = render('@define("t", "见 @cite(\\\"a\\\") {note}")\n\n@use("t", { note: "!" })\n\n@bibliography()', {
    data: { bibliography: { a: { number: 1 } } },
  });
  assert.match(h, /href="#cite-1"/); // 模板字面 cite 动态编号
  h = render('@define("t", "{标题}：{内容}")\n\n@use("t", { 标题: "甲", 内容: "乙" })');
  assert.match(h, /甲：乙/); // 中文键
  h = render(['@define("t", "H={v}")', '@use("t", { v: "x" })']);
  assert.match(h, /H=x/); // 跨文档可见
});

test('公式/代码渲染缓存：输出一致且跨实例复用', () => {  const doc = '$a^2$ 与 $a^2$ 与 ```js\nvar x = 1;\n``` 与 ```js\nvar x = 1;\n```';
  // 冷渲染与缓存命中渲染输出逐字节一致
  const h1 = render(doc);
  const h2 = render(doc);
  assert.strictEqual(h1, h2);
  // 自定义 mathRenderer 不走缓存（不影响输出）
  const h3 = render('$x$ $x$', { mathRenderer: (s) => `[${s}]` });
  assert.match(h3, /\[x\]<\/span> <span class="math-inline">\[x\]/);
});

test('escapeHtml 默认转义正文特殊字符', () => {
  const h = render('a < b & c');
  assert.match(h, /a &lt; b &amp; c/);
  const h2 = render('a < b & c', { escapeHtml: false });
  assert.match(h2, /a < b & c/);
});

test('RAW_HTML 标签透传（不转义）', () => {
  assert.match(render('<b>x</b>'), /<p><b>x<\/b><\/p>/);
});

test('异步渲染与同步一致', async () => {
  const src = '@cite("doe2020") 与 @term("词干提取")';
  const [a, b] = [await render(src, { data, async: true }), render(src, { data })];
  assert.equal(a, b);
});

test('异步自定义函数（Promise）', async () => {
  const renderer = new HTMLRenderer();
  renderer.addFunction('fetch', async (url) => `数据:${url}`);
  const h = await renderer.renderAsync('@fetch("api")', { escapeHtml: false });
  assert.match(h, /数据:api/);
});

test('同步渲染 Promise 输出提示注释', () => {
  const renderer = new HTMLRenderer();
  renderer.addFunction('fetch', async (url) => `数据`);
  const h = renderer.render('@fetch("api")');
  assert.match(h, /需使用 renderAsync/);
});
