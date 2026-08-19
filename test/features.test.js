// 特性测试：@let / @set / 跨文档合并 / 自定义函数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  render, Parser, dumpAST, llmReport,
} from '../src/index.js';
import { HTMLRenderer } from '../src/renderer.js';

test('@let 声明与引用', () => {
  assert.match(render('@let("x", 5)\n\n@if(x > 3, "大", "小")'), /大/);
});

test('@let 全文档可见（引用在声明前）', () => {
  assert.match(render('@if(y == "ok", "通过", "失败")\n\n@let("y", "ok")'), /通过/);
});

test('@let 同名覆盖', () => {
  assert.match(render('@let("x", 1)\n@let("x", 2)\n\n@if(x == 2, "two", "one")'), /two/);
});

test('@let 无输出', () => {
  const h = render('@let("x", 5)\n\n正文');
  assert.ok(!h.includes('let'));
  assert.match(h, /<p>正文<\/p>/);
});

test('@set 参数可引用 @let 变量', () => {
  const h = render('@let("threshold", 5)\n@set({ variables: { v: threshold } })\n\n@if(v >= 5, "达标", "不足")');
  assert.match(h, /达标/);
});

test('@set 增量合并 terms', () => {
  const h = render('@set({ terms: { a: "A" } })\n@set({ terms: { b: "B" } })\n@term("a") @term("b")');
  assert.match(h, />A<\/span> <span class="term"[^>]*>B<\/span>/);
});

test('@set 覆盖 API 数据', () => {
  const h = render('@set({ bibliography: { doe2020: { number: 9 } } })\n@cite("doe2020")\n\n@bibliography()', {
    data: { bibliography: { doe2020: { number: 1 } } },
  });
  // @set 合并后 doe2020 仍存在（无 authors 字段时条目为空）
  assert.match(h, /<li id="cite-1"><\/li>/);
});

test('跨文档合并：编号连续 + 跨文档引用', () => {
  const d1 = '# 引言 {#sec:intro}\n\n文献一 @cite("doe2020")\n\n![图A](/a.png){#fig:a} 图A';
  const d2 = '## 方法 {#sec:method}\n\n如 @ref("sec:intro") 所述，见 @ref("fig:a")。\n\n文献二 @cite("smith2019")';
  const h = render([d1, d2], {
    data: { bibliography: { doe2020: { number: 1 }, smith2019: { number: 2 } } },
  });
  assert.match(h, /href="#sec:intro"[^>]*>引言<\/a>/);
  assert.match(h, /href="#fig:a"[^>]*>图 1<\/a>/);
  assert.match(h, /id="ref-cite-2"[^>]*>\[2\]<\/a>/);
});

test('跨文档合并：@set 全局生效', () => {
  const d1 = '@set({ bibliography: { x: { number: 1 } } })\n\n甲 @cite("x")';
  const d2 = '乙 @cite("x")';
  const h = render([d1, d2]);
  // 两处引用均可用（同一编号）
  assert.match(h, /甲 <sup><a href="#cite-1"[^>]*>\[1\]<\/a><\/sup>/);
  assert.match(h, /乙 <sup><a href="#cite-1"[^>]*>\[1\]<\/a><\/sup>/);
});

test('跨文档合并：脚注跨文档重编号', () => {
  const f1 = '甲[^a]\n\n[^a]: 甲注';
  const f2 = '乙[^b]\n\n[^b]: 乙注';
  const h = render([f1, f2]);
  assert.match(h, /id="fn-1">甲注/);
  assert.match(h, /id="fn-2">乙注/);
});

test('跨文档合并异步一致', async () => {
  const docs = ['A @cite("doe2020")', 'B @cite("smith2019")'];
  const opts = { data: { bibliography: { doe2020: { number: 1 }, smith2019: { number: 2 } } } };
  const [a, b] = [await render(docs, { ...opts, async: true }), render(docs, opts)];
  assert.equal(a, b);
});

test('多文档合并渲染：数组输入自动合并', () => {
  const p = new Parser();
  const d1 = p.parseText('甲 @cite("x")');
  const d2 = p.parseText('乙 @cite("x")');
  const h = render([d1, d2]);
  assert.ok(h.includes('甲') && h.includes('乙'));
});

test('自定义函数（渲染器 addFunction）', () => {
  const renderer = new HTMLRenderer();
  renderer.addFunction('greet', (name) => `<b>Hello ${name}!</b>`);
  const h = renderer.render('@greet("World")', { escapeHtml: false });
  assert.match(h, /<b>Hello World!<\/b>/);
});

test('自定义函数 kwargs', () => {
  const renderer = new HTMLRenderer();
  renderer.addFunction('wrap', (text, kwargs) => `<${kwargs.tag}>${text}</${kwargs.tag}>`);
  const h = renderer.render('@wrap("hi", tag="em")', { escapeHtml: false });
  assert.match(h, /<em>hi<\/em>/);
});

test('dumpAST 输出树形结构', () => {
  const doc = new Parser().parseText('# 标题');
  const tree = dumpAST(doc);
  assert.match(tree, /Document/);
  assert.match(tree, /Heading/);
});

test('块级编辑：块源区间连续覆盖（含 caption 归并、脚注定义截断）', () => {
  const doc = ['# 标题', '', '正文[^n1]', '', '![图A](/a.png){#fig:1}', '', '```js', 'var x = 1;', '```', '', '[^n1]: 注释'].join('\n');
  const d = new Parser().parseText(doc);
  const blocks = d.blocks;
  assert.strictEqual(blocks.length, 4);
  // 区间连续：块 i endPos === 块 i+1 startPos；末块不含脚注定义行
  for (let i = 0; i < blocks.length - 1; i++) {
    assert.strictEqual(blocks[i].endPos, blocks[i + 1].startPos);
  }
  assert.ok(!blocks[blocks.length - 1].raw.includes('[^n1]:'));
  assert.ok(blocks[2].raw.includes('![图A](/a.png){#fig:1}'));
});

test('块级编辑：renderBlocks 哨兵与 blockHashes 定位变化块', () => {
  const doc = ['# 标题', '', '第一段 @cite("a")', '', '第二段'].join('\n');
  const r1 = render(doc, { data: { bibliography: { a: { number: 1 } } }, blocks: true });
  assert.match(r1.html, /<!--mslang:0-->/);
  assert.strictEqual(r1.html.replace(/<!--mslang:\d+-->\n/g, ''), render(doc, { data: { bibliography: { a: { number: 1 } } } }));
  // 编辑第一段：只有该块哈希变
  const r2 = render(doc.replace('第一段 @cite("a")', '改过的 @cite("a")'), { data: { bibliography: { a: { number: 1 } } }, blocks: true });
  const changed = Object.keys(r1.blockHashes).filter(k => r1.blockHashes[k] !== r2.blockHashes[k]);
  assert.deepStrictEqual(changed, ['1']);
  // 脚注变化只影响 footnotes 哈希
  const rf1 = render('正文[^n]\n\n[^n]: 甲', { blocks: true });
  const rf2 = render('正文[^n]\n\n[^n]: 乙', { blocks: true });
  assert.notStrictEqual(rf1.blockHashes.footnotes, rf2.blockHashes.footnotes);
  assert.strictEqual(rf1.blockHashes[0], rf2.blockHashes[0]);
});

test('错误容错：表达式语法错误输出注释不崩溃', () => {
  const h = render('@if(, "a", "b")');
  assert.match(h, /参数解析错误/);
});

test('插件：@plugin 注册与调用（需宿主显式 allowPlugins:true）', () => {
  const PO = { allowPlugins: true };
  assert.match(render('@plugin("double", "(x) => x * 2")\n\n@double(21)', PO), /42/);
  // kwargs
  const h = render('@plugin("wrap", "(x, kwargs) => \\"<\\" + kwargs.tag + \\">\\" + x + \\"</\\" + kwargs.tag + \\">\\"")\n\n@wrap("hi", tag="em")', PO);
  assert.match(h, /<em>hi<\/em>/);
  // 动态 HTML 渲染
  const h2 = render('@plugin("ul", "(items) => items.map(i => \\"<li>\\" + i + \\"</li>\\").join(\\"\\")")\n\n@ul(["a", "b"])', PO);
  assert.match(h2, /<li>a<\/li><li>b<\/li>/);
});

test('插件：默认关闭、host 锁、覆盖内置/宿主函数、错误容错', () => {
  // 默认关闭：@plugin 不注册（调用 unknown 占位）；宿主显式 allowPlugins:true 开启
  assert.match(render('@plugin("f", "(x) => x * 2")\n\n@f(21)'), /unknown function @f/);
  assert.match(render('@plugin("f", "(x) => x * 2")\n\n@f(21)', { allowPlugins: true }), /42/);
  // 文档 @set 不能打开（host 锁）
  assert.match(render('@set({ allowPlugins: true })\n@plugin("f", "(x) => x * 2")\n\n@f(21)'), /unknown function @f/);
  // 覆盖内置 cite
  const h = render('@plugin("cite", "(x) => \\"X\\"") 与 @cite("k")', {
    data: { bibliography: { k: { number: 1 } } },
    allowPlugins: true,
  });
  assert.match(h, /X/);
  assert.ok(!h.includes('cite-1'));
  // 编译错误容错（不崩溃）
  assert.match(render('@plugin("bad", "((")\n\n@bad(1)', { allowPlugins: true }), /<!-- mslang/);
});

test('安全边界：URL scheme 白名单 + 宏递归深度', () => {
  // javascript:/非 image data: 拒绝（链接与图片）
  assert.ok(!render('[x](javascript:alert(1))').includes('href="javascript:'));
  assert.ok(!render('![x](javascript:alert(1))').includes('src="javascript:'));
  assert.ok(!render('[x](data:text/html;base64,ABC)').includes('data:text/html'));
  // 合法链接保留（http/https/mailto/ftp/相对路径/锚点/图片 blob/data:image）
  assert.match(render('[官网](https://example.com/a)'), /href="https:\/\/example.com\/a"/);
  assert.match(render('[邮箱](mailto:a@b.c)'), /href="mailto:a@b\.c"/);
  assert.match(render('[相对](./x.md)'), /href="\.\/x\.md"/);
  assert.match(render('![图](data:image/png;base64,AAAA)'), /src="data:image\/png/);
  assert.match(render('[主站](/home)'), /href="\/home"/);
  // 宏递归超限（自引用宏）
  const r = render('@define("loop", "@use(\\"loop\\")")\n\n@use("loop")', { allowPlugins: false });
  assert.match(r, /宏递归超限/);
});

test('插件：异步与跨文档合并', async () => {
  const PO = { allowPlugins: true };
  const ah = await render('@plugin("fetch", "async (u) => \\"<b>\\" + u + \\"</b>\\"")\n\n@fetch("api")', { ...PO, async: true });
  assert.match(ah, /<b>api<\/b>/);
  // 文档1注册，文档2调用
  const h = render(['@plugin("inc", "(x) => x + 1")', '@inc(41)'], PO);
  assert.match(h, /42/);
});

test('@part/@end 具名可引用区间', () => {
  const h = render('@part("h1", "笔记")\n\n> 原文内容\n\n分析内容\n@end');
  assert.match(h, /<section class="part" id="h1">/);
  assert.match(h, /<h2>笔记<\/h2>/);
  assert.match(h, /原文内容/);
  assert.ok(!h.includes('@end'), '@end 行不残留');
  // 紧贴写法 "正文\n@end"：内容保留
  assert.match(render('@part("a", "A")\n\n正文\n@end'), /<p>正文<\/p>/);
  // 嵌套 part
  const nested = render('@part("a","外")\n\n甲\n\n@part("b","内")\n\n乙\n@end\n\n@end');
  assert.match(nested, /<section class="part" id="a">/);
  assert.match(nested, /<section class="part" id="b">/);
  // part id 可被 @ref 引用
  assert.match(render('@part("p1", "片段")\n\n甲\n@end\n\n见 @ref("p1")', { refNumbering: '' }), /见 <a href="#p1"[^>]*>片段<\/a>/);
  // 孤立 @end 保留
  assert.match(render('甲\n\n@end'), /@end/);
});

test('@include 跨文档引用（动态 loader）', async () => {
  const DOCS = {
    'a.msl': '@part("p1", "笔记一")\n\n> 原文A\n\n分析A\n@end\n\n@part("p2", "笔记二")\n\n![图](/a.png){#fig:1}\n\n{#fig:1} 实验\n\n见图 @ref("fig:1")\n@end',
    'b.msl': '@part("p3", "嵌套")\n\n@include("a.msl", "p1")\n@end',
  };
  const loader = (p) => DOCS[p];
  // 引用另一文档的一段话：统一编号 + 引用解析 + @set 剥离
  const h = render('@include("a.msl", "p1")', { include: loader });
  assert.match(h, /原文A/);
  assert.match(h, /分析A/);
  assert.ok(!h.includes('<h2>笔记一</h2>'), '标记行不渲染');
  assert.ok(!h.includes('@end'), 'end 不残留');
  // 图表编号进入汇总文档（caption 归并 + @ref 解析）
  const h2 = render('@include("a.msl", "p2")', { include: loader });
  assert.match(h2, /图 1：实验/);
  assert.match(h2, /href="#fig:1"/);
  // 嵌套 include（b 内含 a）
  const h3 = render('@include("b.msl", "p3")', { include: loader });
  assert.match(h3, /原文A/);
  // 循环引用
  const loop = render('@include("c.msl", "x")', {
    include: (p) => '@part("x", "X")\n\n@include("c.msl", "x")\n@end',
  });
  assert.match(loop, /循环引用/);
  // 缺失：check issues（missing_include/missing_part 合并进 check 结果）
  const r = render('@include("nope.msl", "x")\n\n@include("a.msl", "nope")', { include: loader, check: true });
  assert.ok(r.issues.some((i) => i.type === 'missing_include' && i.key === 'nope.msl'));
  assert.ok(r.issues.some((i) => i.type === 'missing_part' && i.key === 'nope'));
  assert.match(r.html, /<!-- mslang: include 加载失败 "nope.msl" -->/);
  assert.match(r.html, /<!-- mslang: 未找到 part "nope" -->/);
  // 异步 loader
  const ar = await render('@include("a.msl", "p1")', { include: async (p) => DOCS[p], async: true });
  assert.match(ar, /原文A/);
  // blocks 模式
  const br = render('@include("a.msl", "p1")', { include: loader, blocks: true });
  assert.match(br.html, /原文A/);
  // 剥离 @set 保留 @let
  const setDoc = { 'c.msl': '@part("h", "配置")\n\n@set({ citeStyle: "author-year" })\n@let("v", 42)\n值 @if(v > 0, "V", "X")\n@end' };
  const h4 = render('@include("c.msl", "h")', { include: (p) => setDoc[p] });
  assert.match(h4, /V/);
  assert.ok(!h4.includes('author-year'));
  // llmReport 文案
  const report = llmReport(r.issues);
  assert.match(report, /include 加载失败/);
  assert.match(report, /引用了不存在的 part/);
});
