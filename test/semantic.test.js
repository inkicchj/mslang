// semantic/normalize/diagnostics 层 contract tests（不测 HTML）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from '../src/parser.js';
import { RuntimeContext } from '../src/runtime.js';
import { SemanticAnalyzer, checkIntegrity } from '../src/semantic.js';
import { normalizeDocument } from '../src/normalize.js';

function analyze(src, options = {}) {
  const document = new Parser().parseText(src);
  const runtime = new RuntimeContext({});
  runtime.resetHost(options);
  const semantic = new SemanticAnalyzer({ runtime }).analyze(document);
  return { document, runtime, semantic };
}

test('normalize：定理环境归并（Raw → Stable contract）', () => {
  // Raw AST：@theorem 标记行还是独立 Paragraph（未归并）
  const raw = new Parser().parseTextRaw('@theorem("thm:1", "主定理")\n\n内容甲');
  assert.equal(raw.blocks[0].constructor.name, 'Paragraph', 'Raw 阶段未归并');
  normalizeDocument(raw);
  assert.equal(raw.blocks[0].constructor.name, 'Theorem');
  assert.equal(raw.blocks[0].label, 'thm:1');
  assert.equal(raw.blocks.length, 1);
});

test('normalize：@part 区间归并（嵌套 + 紧贴 @end，Raw → Stable）', () => {
  const raw = new Parser().parseTextRaw('@part("a", "外")\n\n甲\n\n@part("b", "内")\n\n乙\n@end\n\n@end');
  normalizeDocument(raw);
  assert.equal(raw.blocks[0].constructor.name, 'PartBlock');
  assert.equal(raw.blocks[0].id, 'a');
  assert.equal(raw.blocks[0].blocks[1].constructor.name, 'PartBlock');
  assert.equal(raw.blocks[0].blocks[1].id, 'b');
});

test('semantic：引用与编号（表/图/标题 refs + cite 顺序）', () => {
  const { semantic } = analyze('@cite("b") @cite("a")\n\n# 标题 {#sec:1}\n\n| x |{#tbl:t}|\n|---|\n| 1 |');
  assert.equal(semantic.citeOrder[0], 'b');
  assert.equal(semantic.citeNumbers.a, 2);
  assert.equal(semantic.refs['sec:1'].kind, 'sec');
  assert.equal(semantic.refs['tbl:t'].kind, 'tbl');
});

test('semantic：编号提前（headingNumbering 影响标题序列）', () => {
  const { semantic } = analyze('# A\n\n## B', { headingNumbering: '1.1' });
  assert.deepEqual(semantic.headingSeq, ['1', '1.1']);
  const { semantic: s2 } = analyze('# A\n\n## B');
  assert.deepEqual(s2.headingSeq, ['', '']);
});

test('diagnostics：checkIntegrity 标准结构', () => {
  const { document, runtime, semantic } = analyze('见 @cite("nope")');
  const diags = checkIntegrity(document, runtime, semantic);
  assert.equal(diags[0].code, 'missing-citation');
  assert.equal(diags[0].severity, 'warning');
  assert.equal(typeof diags[0].message, 'string');
  assert.equal(typeof diags[0].data.label, 'string');
  assert.equal(diags[0].count, 1);
  assert.ok('span' in diags[0]);
});
