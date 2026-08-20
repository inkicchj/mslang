// 0.3 学术一致性诊断：确定性检查（unused/unreferenced/missing-*）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, render } from '../src/index.js';

test('academic：未引用的图/表/式/定理', async () => {
  const src = [
    '![图](/a.png){#fig:1}',
    '',
    '| x |{#tbl:t}|',
    '|---|',
    '| 1 |',
    '',
    '$$e=mc^2$${#eq:x}',
    '',
    '![图2](/b.png){#fig:2}',
    '',
    '见 @ref("fig:2")',
  ].join('\n');
  const { diagnostics } = await analyze(src);
  const codes = diagnostics.filter((d) => d.severity === 'info').map((d) => d.code);
  assert.ok(codes.includes('unreferenced-figure'), 'unreferenced-figure 应报（fig:1）');
  assert.ok(codes.includes('unreferenced-table'), 'unreferenced-table 应报');
  assert.ok(codes.includes('unused-label'), 'unused-label 应报（公式）');
  // fig:2 已被引用 → 不报
  assert.ok(!diagnostics.some((d) => d.code === 'unreferenced-figure' && d.data.label === 'fig:2'));
  // 信息级 severity
  const f = diagnostics.find((d) => d.code === 'unreferenced-figure' && d.data.label === 'fig:1');
  assert.equal(f.severity, 'info');
});

test('academic：unused-bibliography（数据条目未被引用）', async () => {
  const data = {
    bibliography: { used: { authors: 'A' }, unused: { authors: 'B' } },
  };
  const { diagnostics } = await analyze('引 @cite("used")', { data });
  const d = diagnostics.find((x) => x.code === 'unused-bibliography');
  assert.ok(d && d.data.label === 'unused');
  assert.ok(!diagnostics.some((x) => x.code === 'unused-bibliography' && x.data.label === 'used'));
});

test('academic：meta 缺失（已声明 meta 时检查）', async () => {
  const { diagnostics } = await analyze('@meta({ title: "T" })\n\n正文');
  const codes = diagnostics.filter((d) => d.severity === 'info').map((d) => d.code);
  assert.ok(codes.includes('missing-title') === false, 'title 已提供');
  assert.ok(codes.includes('missing-abstract'), '缺 abstract');
  assert.ok(codes.includes('missing-keywords'), '缺 keywords');
});

test('academic：常规文档不报 missing-*', async () => {
  const { diagnostics } = await analyze('普通段落\n\n# 标题');
  assert.ok(!diagnostics.some((d) => d.code.startsWith('missing-')), '无 meta 不检查缺失');
});

test('academic：render check 也输出一致性提示（type 直接用 code）', () => {
  const r = render('![图](/a.png){#fig:1}', { check: true });
  assert.ok(r.issues.some((i) => i.type === 'unreferenced-figure' && i.key === 'fig:1'));
});
