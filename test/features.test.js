// 特性测试：@let / @set / 跨文档合并 / 自定义函数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mslangToHTML, mslangToHTMLAsync, mslangToHTMLAll, mslangToHTMLAllAsync, mslangToHTMLBlocks,
  HTMLRenderer, mergeDocuments, Parser, Lexer, dumpAST,
} from '../src/index.js';

test('@let 声明与引用', () => {
  assert.match(mslangToHTML('@let("x", 5)\n\n@if(x > 3, "大", "小")'), /大/);
});

test('@let 全文档可见（引用在声明前）', () => {
  assert.match(mslangToHTML('@if(y == "ok", "通过", "失败")\n\n@let("y", "ok")'), /通过/);
});

test('@let 同名覆盖', () => {
  assert.match(mslangToHTML('@let("x", 1)\n@let("x", 2)\n\n@if(x == 2, "two", "one")'), /two/);
});

test('@let 无输出', () => {
  const h = mslangToHTML('@let("x", 5)\n\n正文');
  assert.ok(!h.includes('let'));
  assert.match(h, /<p>正文<\/p>/);
});

test('@set 参数可引用 @let 变量', () => {
  const h = mslangToHTML('@let("threshold", 5)\n@set({ variables: { v: threshold } })\n\n@if(v >= 5, "达标", "不足")');
  assert.match(h, /达标/);
});

test('@set 增量合并 terms', () => {
  const h = mslangToHTML('@set({ terms: { a: "A" } })\n@set({ terms: { b: "B" } })\n@term("a") @term("b")');
  assert.match(h, />A<\/span> <span class="term"[^>]*>B<\/span>/);
});

test('@set 覆盖 API 数据', () => {
  const h = mslangToHTML('@set({ bibliography: { doe2020: { number: 9 } } })\n@cite("doe2020")\n\n@bibliography()', {
    data: { bibliography: { doe2020: { number: 1 } } },
  });
  // @set 合并后 doe2020 仍存在（无 authors 字段时条目为空）
  assert.match(h, /<li id="cite-1"><\/li>/);
});

test('跨文档合并：编号连续 + 跨文档引用', () => {
  const d1 = '# 引言 {#sec:intro}\n\n文献一 @cite("doe2020")\n\n![图A](/a.png){#fig:a} 图A';
  const d2 = '## 方法 {#sec:method}\n\n如 @ref("sec:intro") 所述，见 @ref("fig:a")。\n\n文献二 @cite("smith2019")';
  const h = mslangToHTMLAll([d1, d2], {
    data: { bibliography: { doe2020: { number: 1 }, smith2019: { number: 2 } } },
  });
  assert.match(h, /href="#sec:intro"[^>]*>引言<\/a>/);
  assert.match(h, /href="#fig:a"[^>]*>图 1<\/a>/);
  assert.match(h, /id="ref-cite-2"[^>]*>\[2\]<\/a>/);
});

test('跨文档合并：@set 全局生效', () => {
  const d1 = '@set({ bibliography: { x: { number: 1 } } })\n\n甲 @cite("x")';
  const d2 = '乙 @cite("x")';
  const h = mslangToHTMLAll([d1, d2]);
  // 两处引用均可用（同一编号）
  assert.match(h, /甲 <sup><a href="#cite-1"[^>]*>\[1\]<\/a><\/sup>/);
  assert.match(h, /乙 <sup><a href="#cite-1"[^>]*>\[1\]<\/a><\/sup>/);
});

test('跨文档合并：脚注跨文档重编号', () => {
  const f1 = '甲[^a]\n\n[^a]: 甲注';
  const f2 = '乙[^b]\n\n[^b]: 乙注';
  const h = mslangToHTMLAll([f1, f2]);
  assert.match(h, /id="fn-1">甲注/);
  assert.match(h, /id="fn-2">乙注/);
});

test('跨文档合并异步一致', async () => {
  const docs = ['A @cite("doe2020")', 'B @cite("smith2019")'];
  const opts = { data: { bibliography: { doe2020: { number: 1 }, smith2019: { number: 2 } } } };
  const [a, b] = [await mslangToHTMLAllAsync(docs, opts), mslangToHTMLAll(docs, opts)];
  assert.equal(a, b);
});

test('mergeDocuments 直接使用', () => {
  const p = new Parser();
  const d1 = p.parse(new Lexer('A').tokenize());
  const d2 = p.parse(new Lexer('B').tokenize());
  const m = mergeDocuments(d1, d2);
  assert.equal(m.blocks.length, 2);
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
  const doc = new Parser().parse(new Lexer('# 标题').tokenize());
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
  const r1 = mslangToHTMLBlocks(doc, { data: { bibliography: { a: { number: 1 } } } });
  assert.match(r1.html, /<!--mslang:0-->/);
  assert.strictEqual(r1.html.replace(/<!--mslang:\d+-->\n/g, ''), mslangToHTML(doc, { data: { bibliography: { a: { number: 1 } } } }));
  // 编辑第一段：只有该块哈希变
  const r2 = mslangToHTMLBlocks(doc.replace('第一段 @cite("a")', '改过的 @cite("a")'), { data: { bibliography: { a: { number: 1 } } } });
  const changed = Object.keys(r1.blockHashes).filter(k => r1.blockHashes[k] !== r2.blockHashes[k]);
  assert.deepStrictEqual(changed, ['1']);
  // 脚注变化只影响 footnotes 哈希
  const rf1 = mslangToHTMLBlocks('正文[^n]\n\n[^n]: 甲');
  const rf2 = mslangToHTMLBlocks('正文[^n]\n\n[^n]: 乙');
  assert.notStrictEqual(rf1.blockHashes.footnotes, rf2.blockHashes.footnotes);
  assert.strictEqual(rf1.blockHashes[0], rf2.blockHashes[0]);
});

test('错误容错：表达式语法错误输出注释不崩溃', () => {
  const h = mslangToHTML('@if(, "a", "b")');
  assert.match(h, /参数解析错误/);
});

test('插件：@plugin 注册与调用', () => {
  assert.match(mslangToHTML('@plugin("double", "(x) => x * 2")\n\n@double(21)'), /42/);
  // kwargs
  const h = mslangToHTML('@plugin("wrap", "(x, kwargs) => \\"<\\" + kwargs.tag + \\">\\" + x + \\"</\\" + kwargs.tag + \\">\\"")\n\n@wrap("hi", tag="em")');
  assert.match(h, /<em>hi<\/em>/);
  // 动态 HTML 渲染
  const h2 = mslangToHTML('@plugin("ul", "(items) => items.map(i => \\"<li>\\" + i + \\"</li>\\").join(\\"\\")")\n\n@ul(["a", "b"])');
  assert.match(h2, /<li>a<\/li><li>b<\/li>/);
});

test('插件：覆盖内置/宿主函数、错误容错、开关', () => {
  // 覆盖内置 cite
  const h = mslangToHTML('@plugin("cite", "(x) => \\"X\\"") 与 @cite("k")', {
    data: { bibliography: { k: { number: 1 } } },
  });
  assert.match(h, /X/);
  assert.ok(!h.includes('cite-1'));
  // 编译错误容错（不崩溃）
  assert.match(mslangToHTML('@plugin("bad", "((")\n\n@bad(1)'), /<!-- mslang/);
  // allowPlugins 默认开启；可关闭（API 与 @set）
  assert.match(mslangToHTML('@plugin("f", "(x) => 1")\n\n@f(1)', { allowPlugins: false }), /<!-- mslang/);
  assert.match(mslangToHTML('@set({ allowPlugins: false })\n@plugin("f", "(x) => 1")\n\n@f(1)'), /<!-- mslang/);
});

test('插件：异步与跨文档合并', async () => {
  const ah = await mslangToHTMLAsync('@plugin("fetch", "async (u) => \\"<b>\\" + u + \\"</b>\\"")\n\n@fetch("api")');
  assert.match(ah, /<b>api<\/b>/);
  // 文档1注册，文档2调用
  const h = mslangToHTMLAll(['@plugin("inc", "(x) => x + 1")', '@inc(41)']);
  assert.match(h, /42/);
});
