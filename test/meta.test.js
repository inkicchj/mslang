// 论文元数据：@meta 头部 / options.meta 合并（0.3 学术数据模型）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, analyze, render, toJSON } from '../src/index.js';

test('meta：@meta 头部 → document.meta（parse 与 analyze 一致）', async () => {
  const src = '@meta({ title: "T", authors: ["张三"], keywords: ["AI"] })\n\n# 标题';
  const p = parse(src);
  assert.deepEqual(p.meta, { title: 'T', authors: ['张三'], keywords: ['AI'] });
  const a = await analyze(src);
  assert.deepEqual(a.document.meta, { title: 'T', authors: ['张三'], keywords: ['AI'] });
});

test('meta：options.meta 与 @meta 合并（后者覆盖），渲染无输出', async () => {
  const src = '@meta({ title: "A", language: "zh-CN" })\n\n正文';
  const a = await analyze(src, { meta: { title: 'HOST', authors: ['李四'] } });
  assert.deepEqual(a.document.meta, {
    title: 'A', language: 'zh-CN', authors: ['李四'],
  });
  // @meta 块在渲染时不产生可见输出
  const h = render(src);
  assert.match(h, /正文/);
  assert.ok(!h.includes('zh-CN'));
});

test('meta：不渲染且不影响块结构/诊断', async () => {
  const src = '@meta({ title: "T" })\n\n看 @cite("nope")';
  const a = await analyze(src);
  // @meta 仍是块（meta 函数输出空），缺失文献诊断照常
  assert.equal(a.document.blocks[0].constructor.name, 'Paragraph');
  assert.ok(a.diagnostics.some(d => d.code === 'missing-citation'));
});

test('meta：toJSON 不泄漏内部字段', () => {
  const p = parse('@meta({ title: "T" })\n\n正文');
  const json = toJSON(p);
  assert.deepEqual(json.meta, { title: 'T' });
});
