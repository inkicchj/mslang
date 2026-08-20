// SourceMap：include 展开后 span 溯源（0.3：定位源文件）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/index.js';
import { TextBuilder, SourceMap } from '../src/source-map.js';

const files = {
  'ch1.msl': '# 第一章\n\n@part("intro")\n\n引言的缺引 @cite("nope")。\n\n@end',
  'ch2.msl': '@part("sec2")\n\n第二章内容 见 @ref("no")。\n@end',
};

test('source-map：TextBuilder 分段合并连续同源', () => {
  const b = new TextBuilder('main.msl');
  b.line('根1');
  b.block('被引1\n被引2', 'ch1.msl');
  b.line('根2');
  const segs = b.buildSegments();
  assert.deepEqual(segs, [
    { sourceId: 'main.msl', start: 0, end: 2 },
    { sourceId: 'ch1.msl', start: 3, end: 10 },
    { sourceId: 'main.msl', start: 11, end: 13 },
  ]);
});

test('source-map：locate 命中偏移所属段（换行符归前段）', () => {
  const b = new TextBuilder(null);
  b.block('AAA', 'a.msl');
  b.line('根');
  const map = SourceMap.fromBuilder(b);
  assert.equal(map.locate(0).sourceId, 'a.msl');
  assert.equal(map.isIncluded(0), true);
  assert.equal(map.locate(4).sourceId, null, '根行无来源');
  assert.equal(map.locate(-1), null);
});

test('source-map：include 后缺失文献诊断 span 带 sourceId（定位源文件）', async () => {
  const { diagnostics, sourceMap } = await analyze('前言\n\n@include("ch1.msl", "intro")\n\n结尾', {
    include: (p) => files[p], sourceId: 'main.msl',
  });
  assert.ok(sourceMap, '应有 sourceMap');
  const d = diagnostics.find((x) => x.code === 'missing-citation');
  assert.ok(d, '应有 missing-citation');
  assert.equal(d.span.sourceId, 'ch1.msl', '缺失引用应溯源到 ch1.msl');
  assert.ok(d.span.start < d.span.end);
});

test('source-map：根文档诊断 span 无 sourceId（0.2 兼容）', async () => {
  const { diagnostics } = await analyze('见 @cite("nope")');
  const d = diagnostics.find((x) => x.code === 'missing-citation');
  assert.equal(d.span.sourceId, undefined);
});

test('source-map：多个 include 各带各自 sourceId', async () => {
  const { diagnostics } = await analyze('@include("ch1.msl","intro")\n\n@include("ch2.msl","sec2")', {
    include: (p) => files[p], sourceId: 'main.msl',
  });
  const cit = diagnostics.find((x) => x.code === 'missing-citation');
  const ref = diagnostics.find((x) => x.code === 'missing-reference');
  assert.equal(cit.span.sourceId, 'ch1.msl');
  assert.equal(ref.span.sourceId, 'ch2.msl');
});

test('source-map：无 include 时 analyze 返回 sourceMap=null', async () => {
  const { sourceMap } = await analyze('普通文档');
  assert.equal(sourceMap, null);
});
