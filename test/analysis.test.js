// 0.3 论文分析模型：outline / sections / figures / tables / references / stats
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/index.js';

const data = {
  bibliography: {
    a: { authors: 'Doe', year: 2020, title: 'A' },
    b: { authors: 'Smith', year: 2019, title: 'B' },
  },
};

const src = [
  '# 引言 {#sec:intro}',
  '',
  '看 @cite("a")。',
  '',
  '![图](/a.png){#fig:1}',
  '',
  '## 方法 {#sec:m}',
  '',
  '@cite("b") 与图。',
  '',
  '| x |{#tbl:t}|',
  '|---|',
  '| 1 |',
  '',
  '$$E=mc^2$${#eq:x}',
  '',
  '@theorem("thm:1", "主定理")',
  '',
  '结论内容',
].join('\n');

test('analysis：outline 标题大纲（层级 + 自动编号 + id）', async () => {
  const { semantic } = await analyze(src, { data, headingNumbering: '1.1' });
  assert.equal(semantic.outline.length, 2);
  assert.deepEqual(semantic.outline[0], {
    level: 1, id: 'sec:intro', text: '引言', number: '1', block: 0,
  });
  assert.equal(semantic.outline[1].level, 2);
  assert.equal(semantic.outline[1].number, '1.1');
});

test('analysis：sections 聚合各节引用/图/表/式/定理', async () => {
  const { semantic } = await analyze(src, { data });
  assert.equal(semantic.sections.length, 2);
  // 第一节：引言 + 图 + cite a
  assert.deepEqual(semantic.sections[0].cites, ['a']);
  assert.deepEqual(semantic.sections[0].figures, ['fig:1']);
  assert.equal(semantic.sections[0].tables.length, 0);
  // 第二节：方法 → cite b / 表 / 式 / 定理
  assert.deepEqual(semantic.sections[1].cites, ['b']);
  assert.deepEqual(semantic.sections[1].tables, ['tbl:t']);
  assert.deepEqual(semantic.sections[1].equations, ['eq:x']);
  assert.deepEqual(semantic.sections[1].theorems, ['thm:1']);
  // 块区间连续
  assert.ok(semantic.sections[0].endBlock <= semantic.sections[1].startBlock);
});

test('analysis：figures/tables/equations/theorems 清单（编号）', async () => {
  const { semantic } = await analyze(src, { data });
  assert.deepEqual(semantic.figures, [{ label: 'fig:1', number: 1 }]);
  assert.deepEqual(semantic.tables, [{ label: 'tbl:t', number: 1 }]);
  assert.deepEqual(semantic.equations, [{ label: 'eq:x', number: 1 }]);
  assert.deepEqual(semantic.theorems, [{ label: 'thm:1', number: 1, type: 'theorem' }]);
});

test('analysis：references 被引文献明细（顺序）', async () => {
  const { semantic } = await analyze(src, { data });
  assert.equal(semantic.references.length, 2);
  assert.equal(semantic.references[0].key, 'a');
  assert.equal(semantic.references[0].number, 1);
  assert.equal(semantic.references[0].entry.authors, 'Doe');
  assert.equal(semantic.references[1].key, 'b');
});

test('analysis：stats 确定性统计', async () => {
  const { semantic } = await analyze(src, { data });
  assert.equal(semantic.stats.citations, 2);
  assert.equal(semantic.stats.figures, 1);
  assert.equal(semantic.stats.tables, 1);
  assert.equal(semantic.stats.equations, 1);
  assert.equal(semantic.stats.theorems, 1);
  assert.equal(semantic.stats.sections, 2);
  assert.equal(semantic.stats.footnotes, 0);
  assert.ok(semantic.stats.words > 0, '正文词数应 > 0');
});
