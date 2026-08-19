// pipeline parity tests：analyze() 与 render() 必须基于完全相同语义（0.2.1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, renderAsync, parse, analyze } from '../src/index.js';

test('parity：@let if 表达式值在 analyze 与 render 一致', () => {
  const src = '@let("x", if(true, 10, 20))\n\n值 @if(x > 5, "大", "小")';
  const a = analyze(src);
  // analyze 暴露 semantic 但不直接暴露 variables；经 @if 渲染验证
  const h = render(src);
  assert.match(h, /值 大<\/p>/);
  // analyze 与 render 同管线 → 变量一致（semantic 编号不受影响，但 analyze 不抛错即证明可求值）
  assert.equal(a.document.blocks.length > 0, true);
});

test('parity：@set headingNumbering 后 analyze refs 与 render @ref 编号一致', () => {
  const src = '@set({ headingNumbering: "1.1" })\n\n# A {#a}\n\n## B {#b}\n\n见 @ref("b")';
  const { semantic } = analyze(src);
  assert.equal(semantic.headingSeq[1], '1.1');
  const h = render(src);
  assert.match(h, /<h1 id="a">1 A<\/h1>/);
  assert.match(h, /<h2 id="b">1.1 B<\/h2>/);
  assert.match(h, /href="#b"[^>]*>1.1<\/a>/);
});

test('parity：citation 顺序在 analyze 与 render 一致', () => {
  const src = '@cite("b") @cite("a")';
  const data = { bibliography: { a: {}, b: {} } };
  const { semantic } = analyze(src, { data });
  assert.equal(semantic.citeOrder[0], 'b');
  assert.equal(semantic.citeNumbers.a, 2);
  const h = render(src, { data });
  assert.match(h, /href="#cite-1"[^>]*data-cite-key="b"[^>]*>\[1\]<\/a>/);
  assert.match(h, /href="#cite-2"[^>]*data-cite-key="a"[^>]*>\[2\]<\/a>/);
});

test('parity：Document 输入与 String 输入语义一致', () => {
  const src = '@set({ headingNumbering: "1" })\n\n# 标题 {#t}\n\n见 @ref("t")';
  const options = { headingNumbering: '1' };
  const ast = parse(src);
  const hStr = render(src, options);
  const hDoc = render(ast, options);
  // 字符串与 Document 应逐字一致（同 prepare 语义）
  assert.equal(hDoc, hStr);
});

test('parity：同步 render 与 renderAsync 输出一致', async () => {
  const src = '@let("x", 5)\n\n# 标题\n\n得分 @if(x > 3, "高", "低")';
  const h1 = render(src);
  const h2 = await renderAsync(src);
  assert.equal(h2, h1);
});

test('parity：渲染期动态注册（变量参数 cite）在 analyze 后 render 仍一致', () => {
  const src = '@let("k", "a")\n\n@cite(k)';
  const data = { bibliography: { a: {} } };
  const a = analyze(src, { data });
  assert.equal(a.document.blocks.length > 0, true);
  const h = render(src, { data });
  assert.match(h, /data-cite-key="a"/);
});

test('parity：多文档数组经 prepare（analyze 与 render 编号一致）', () => {
  const sources = ['# A {#a}\n\n![图](/x.png){#fig:1}', '# B {#b}\n\n见 @ref("fig:1") 与 @ref("b")'];
  const { semantic } = analyze(sources);
  assert.equal(semantic.refs['fig:1'].number, 1);
  assert.equal(semantic.refs.b.kind, 'sec');
  const h = render(sources);
  assert.match(h, /图 1/);
  assert.match(h, /href="#b"[^>]*>[^<]*B/);
  // 数组 + Document 元素混合
  const { semantic: s2 } = analyze([parse(sources[0]), sources[1]]);
  assert.equal(s2.refs['fig:1'].number, 1);
});

test('diagnostics：节点级 span（@cite/@ref/[^n] 精确定位）', () => {
  const src = '前 @cite("x") 后\n\n注[^n1]\n\n见 @ref("no")';
  const { diagnostics } = analyze(src);
  const spanOf = (code) => diagnostics.find(d => d.code === code).span;
  const cit = spanOf('missing-citation');
  const fn = spanOf('missing-footnote');
  const rf = spanOf('missing-reference');
  // "前 @cite" —— @ 在 index 2（"前 " 2 字符）；区间比整块小且端>始
  assert.equal(cit.start, 2);
  assert.ok(cit.end > cit.start);
  assert.ok(fn.end > fn.start);
  assert.ok(rf.end > rf.start);
});

test('边界：脚注重复引用编号（记录现状，0.3 决策同 label 同编号）', () => {
  const src = '甲[^a] 乙[^a]\n\n[^a]: 定义';
  const h = render(src);
  // 现状：每次引用独立编号（1、2）；学术语义"同 label 同编号"留 0.3 决策
  assert.match(h, /id="fnref-1"/);
  assert.match(h, /id="fnref-2"/);
});

test('边界：异常输入（数组元素非法类型抛 TypeError；空文档正常）', () => {
  assert.throws(() => render([123]), TypeError);
  assert.equal(render([]), render(''));
});

