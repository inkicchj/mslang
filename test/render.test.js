// renderer 渲染测试：基础语法、表达式、内置函数、配置、异步
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mslangToHTML, mslangToHTMLAsync, HTMLRenderer } from '../src/index.js';

const data = {
  bibliography: {
    doe2020: { number: 1, authors: 'Doe', year: 2020, title: 'Paper', journal: 'JML' },
    smith2019: { number: 2, authors: 'Smith', year: 2019, title: 'Work', journal: 'ACL' },
  },
  terms: { '词干提取': { label: 'Stemming', url: 'https://stem.example' } },
};

test('基础块级渲染', () => {
  assert.match(mslangToHTML('# 标题'), /<h1>标题<\/h1>/);
  assert.match(mslangToHTML('---'), /<hr>/);
  assert.match(mslangToHTML('> 引用'), /<blockquote>\n引用\n<\/blockquote>/);
});

test('行内语法', () => {
  assert.match(mslangToHTML('**粗** *斜* ~删~ `码`'), /<strong>粗<\/strong> <em>斜<\/em> <sub>删<\/sub> <code>码<\/code>/);
});

test('wrapper 默认 class', () => {
  assert.match(mslangToHTML('文本'), /^<div class="mslang">/);
});

test('表达式逻辑', () => {
  assert.match(mslangToHTML('@if(1+2*3 == 7 && !(2>3), "ok", "no")'), /ok/);
  assert.match(mslangToHTML('@if(false || true, "a", "b")'), /a/);
});

test('表达式短路不触发副作用', () => {
  // false && cite("x")：cite 不求值，不报错
  const h = mslangToHTML('@if(false && cite("x"), "a", "b")', { data });
  assert.match(h, /b/);
});

test('数组与对象字面量', () => {
  assert.match(mslangToHTML('@if(true, ["a", "b"], [])'), /ab/);
  // 对象值非字符串/数组，String 化输出
  const h = mslangToHTML('@if(true, {a: 1}, {})');
  assert.ok(h.includes('[object Object]'));
});

test('cite 编号与文献表', () => {
  const h = mslangToHTML('@cite("doe2020") 与 @cite("smith2019")\n\n@bibliography()', { data });
  assert.match(h, /href="#cite-1"[^>]*>\[1\]<\/a>/);
  assert.match(h, /href="#cite-2"[^>]*>\[2\]<\/a>/);
  assert.match(h, /<li id="cite-1">Doe \(2020\) Paper JML<\/li>/);
});

test('缺失文献占位', () => {
  assert.match(mslangToHTML('@cite("nope")', { data }), /\[nope\?\]/);
});

test('term 渲染（对象带 url）', () => {
  const h = mslangToHTML('@term("词干提取")', { data });
  assert.match(h, /<a href="https:\/\/stem\.example"[^>]*><span class="term">Stemming<\/span><\/a>/);
});

test('term 字符串简写', () => {
  const h = mslangToHTML('@term("缩写")', { data: { terms: { 缩写: '全称' } } });
  assert.match(h, /<span class="term"[^>]*>全称<\/span>/);
});

test('ref 章节（默认标题全文）', () => {
  const h = mslangToHTML('## 方法 {#sec:m}\n\n见 @ref("sec:m")');
  assert.match(h, /href="#sec:m"[^>]*>方法<\/a>/);
});

test('ref 图/表编号', () => {
  const h = mslangToHTML('![图](/a.png){#fig:1}\n\n见 @ref("fig:1")');
  assert.match(h, /href="#fig:1"[^>]*>图 1<\/a>/);
});

test('标题自动编号', () => {
  const h = mslangToHTML('# 一\n\n## 二\n\n### 三', { headingNumbering: '1.1' });
  assert.match(h, /<h1>1 一<\/h1>/);
  assert.match(h, /<h2>1\.1 二<\/h2>/);
  assert.match(h, /<h3>1\.1\.1 三<\/h3>/);
});

test('图片 caption 渲染 figure', () => {
  const h = mslangToHTML('![图A](/a.png){#fig:1}\n\n{#fig:1} 装置');
  assert.match(h, /<figure id="fig:1">\n<img src="\/a\.png" alt="图A" referrerpolicy="no-referrer">\n<figcaption>图 1：装置<\/figcaption>\n<\/figure>/);
});

test('表格 caption 在表头上方', () => {
  const h = mslangToHTML('| x |{#tbl:t}|\n|---|\n| 1 |\n\n{#tbl:t} 数据');
  assert.match(h, /<table id="tbl:t">\n<caption>表 1：数据<\/caption>\n<thead>/);
});

test('captionPrefix @set 配置', () => {
  const h = mslangToHTML('@set({ captionPrefix: { fig: "Figure" } })\n\n![图](/a.png){#fig:1}\n\n{#fig:1} 装置\n\n见 @ref("fig:1")');
  assert.match(h, /<figcaption>Figure 1：装置<\/figcaption>/);
  assert.match(h, />Figure 1<\/a>/);
});

test('引用元数据默认属性', () => {
  const h = mslangToHTML('@cite("doe2020") @term("词干提取")', { data });
  assert.match(h, /data-cite-key="doe2020" data-cite-index="0"/);
  assert.match(h, /data-term-key="词干提取"/);
});

test('引用元数据自定义属性名与关闭', () => {
  const h = mslangToHTML('@cite("doe2020")', { data, citeKeyAttr: 'data-doc' });
  assert.match(h, /data-doc="doe2020"/);
  const h2 = mslangToHTML('@cite("doe2020")', { data, citeKeyAttr: '' });
  assert.ok(!h2.includes('data-cite-key'));
});

test('引用元数据值恒转义', () => {
  const h = mslangToHTML('@cite("a\\"b")', {
    data: { bibliography: { 'a"b': { number: 1 } } }, escapeHtml: false,
  });
  assert.match(h, /data-cite-key="a&quot;b"/);
});

test('条目 key 字段：data 属性输出条目 key（与引用名解耦）', () => {
  // 文献条目 key 字段（如数据库主键）
  const h = mslangToHTML('@cite("doe2020")', {
    data: { bibliography: { doe2020: { number: 1, key: 'uuid-abc-123' } } },
  });
  assert.match(h, /data-cite-key="uuid-abc-123"/);
  // 术语条目 key 字段
  const h2 = mslangToHTML('@term("词干提取")', {
    data: { terms: { 词干提取: { label: 'Stemming', key: 'wqdwqr32r234' } } },
  });
  assert.match(h2, /data-term-key="wqdwqr32r234"/);
});

test('条目无 key 字段时回退引用名', () => {
  const h = mslangToHTML('@cite("doe2020") @term("词干提取")', {
    data: {
      bibliography: { doe2020: { number: 1 } },
      terms: { 词干提取: '词干提取 (Stemming)' },
    },
  });
  assert.match(h, /data-cite-key="doe2020"/);
  assert.match(h, /data-term-key="词干提取"/);
});

test('公式：行内与块级容器（内置 KaTeX 渲染）', () => {
  const h = mslangToHTML('质能方程 $E = mc^2$');
  assert.match(h, /<span class="math-inline"><span class="katex">/);
  assert.match(h, /<annotation encoding="application\/x-tex">E = mc\^2<\/annotation>/);
  const b = mslangToHTML('$$ \\int_0^1 x dx $$');
  assert.match(b, /<div class="math"><span class="katex-display">/);
  assert.match(b, /<annotation encoding="application\/x-tex"> \\int_0\^1 x dx <\/annotation>/);
});

test('公式：块级 label、编号与 @ref', () => {
  const h = mslangToHTML('$$ E = mc^2 $$ {#eq:energy}\n\n见 @ref("eq:energy")');
  assert.match(h, /<div class="math" id="eq:energy">/);
  assert.match(h, />式 1<\/a>/);
});

test('公式：caption 归并渲染 figure', () => {
  const h = mslangToHTML('$$ x = 1 $$ {#eq:a}\n\n{#eq:a} 归一化条件');
  assert.match(h, /<figure id="eq:a">/);
  assert.match(h, /<figcaption>式 1：归一化条件<\/figcaption>/);
});

test('公式：未闭合回退普通文本', () => {
  assert.match(mslangToHTML('价格是 $5 美元'), /<p>价格是 \$5 美元<\/p>/);
  assert.match(mslangToHTML('$$ 未闭合'), /\$\$ 未闭合/);
});

test('公式：\\$ 转义美元符号', () => {
  const h = mslangToHTML('\\$5 与 $x$');
  assert.match(h, /<p>\$5 与 <span class="math-inline"><span class="katex">/);
});

test('公式：mathRenderer 钩子', () => {
  const h = mslangToHTML('$x^2$ 与 $$ y $$', {
    mathRenderer: (src, inline) => `[[${inline ? 'i' : 'b'}:${src}]]`,
  });
  assert.match(h, /<span class="math-inline">\[\[i:x\^2\]\]<\/span>/);
  assert.match(h, /<div class="math">\[\[b: y \]\]<\/div>/);
});

test('公式：内容默认转义防注入', () => {
  assert.match(mslangToHTML('$a < b$'), /a &lt; b/);
});

test('公式：caption 内 cite 参与编号', () => {
  const h = mslangToHTML('$$ x $$ {#eq:1}\n\n{#eq:1} 见 @cite("doe2020")', { data });
  assert.match(h, /href="#cite-1"/);
});

test('公式：文档自动内联 KaTeX CSS（wrapper 外）', () => {
  const h = mslangToHTML('质能方程 $E = mc^2$');
  assert.match(h, /^<style>@font-face/); // style 位于输出开头
  assert.match(h, /\.katex-display/); // CSS 内容已内联
  // 无公式文档不内联
  assert.ok(!mslangToHTML('普通文本').includes('<style>'));
  // 自定义 mathRenderer 时不内联（渲染器自管样式）
  assert.ok(!mslangToHTML('$x$', { mathRenderer: (s, i) => 'X' }).includes('<style>'));
});

test('公式：字体 URL 重写为 CDN（默认）与 mathFontsPath（本地托管）', () => {
  const h = mslangToHTML('$x$');
  assert.match(h, /url\(https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[\d.]+\/dist\/fonts\//);
  // 本地托管：mathFontsPath 覆盖
  const h2 = mslangToHTML('$x$', { mathFontsPath: '/assets/katex-fonts/' });
  assert.match(h2, /url\(\/assets\/katex-fonts\//);
  assert.ok(!h2.includes('jsdelivr'));
});

test('escapeHtml 默认转义正文特殊字符', () => {
  const h = mslangToHTML('a < b & c');
  assert.match(h, /a &lt; b &amp; c/);
  const h2 = mslangToHTML('a < b & c', { escapeHtml: false });
  assert.match(h2, /a < b & c/);
});

test('RAW_HTML 标签透传（不转义）', () => {
  assert.match(mslangToHTML('<b>x</b>'), /<p><b>x<\/b><\/p>/);
});

test('异步渲染与同步一致', async () => {
  const src = '@cite("doe2020") 与 @term("词干提取")';
  const [a, b] = [await mslangToHTMLAsync(src, { data }), mslangToHTML(src, { data })];
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
