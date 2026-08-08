// parser AST 结构测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Parser, Lexer, mergeDocuments,
  Document, Heading, Paragraph, Table, Image, Caption, FootnoteRef,
} from '../src/index.js';

const parse = (src) => new Parser().parse(new Lexer(src).tokenize());

test('Document 结构', () => {
  const doc = parse('# 标题\n\n段落');
  assert.ok(doc instanceof Document);
  assert.equal(doc.blocks.length, 2);
  assert.ok(doc.blocks[0] instanceof Heading);
  assert.ok(doc.blocks[1] instanceof Paragraph);
});

test('标题 id 与层级', () => {
  const [h] = parse('### 小节 {#sec:x}').blocks;
  assert.equal(h.level, 3);
  assert.equal(h.id, 'sec:x');
});

test('caption 归并到图片（label 匹配）', () => {
  const doc = parse('![图](/a.png){#fig:1}\n\n{#fig:1} 实验装置');
  const [p] = doc.blocks;
  assert.ok(p instanceof Paragraph);
  assert.equal(p.content.length, 1);
  const img = p.content[0];
  assert.ok(img instanceof Image);
  assert.equal(img.caption.length, 1);
  assert.equal(img.caption[0].text, '实验装置');
});

test('caption 归并到表格', () => {
  const doc = parse('| x |{#tbl:t}|\n|---|\n| 1 |\n\n{#tbl:t} 数据');
  const tbl = doc.blocks.find(b => b instanceof Table);
  assert.equal(tbl.label, 'tbl:t');
  assert.equal(tbl.caption[0].text, '数据');
});

test('孤立 caption 降级为普通段落（保留原文）', () => {
  const doc = parse('普通段落\n\n{#x} 说明');
  assert.equal(doc.blocks.length, 2);
  assert.ok(doc.blocks[1] instanceof Paragraph);
  assert.equal(doc.blocks[1].content[0].text, '{#x} 说明');
});

test('label 不匹配不归并', () => {
  const doc = parse('![图](/a.png){#fig:1}\n\n{#fig:2} 说明');
  const [p, p2] = doc.blocks;
  assert.equal(p.content[0].caption.length, 0);
  assert.equal(p2.content[0].text, '{#fig:2} 说明');
});

test('图后普通文本不被吞', () => {
  const doc = parse('![图](/a.png)\n\n这是普通文本');
  assert.equal(doc.blocks.length, 2);
  assert.equal(doc.blocks[1].content[0].text, '这是普通文本');
});

test('mergeDocuments 拼接 blocks 与 footnotes', () => {
  const d1 = parse('甲[^a]\n\n[^a]: 甲注');
  const d2 = parse('乙[^b]\n\n[^b]: 乙注');
  const merged = mergeDocuments(d1, d2);
  assert.equal(merged.blocks.length, 2);
  assert.deepEqual(Object.keys(merged.footnotes), ['a', 'b']);
});

test('mergeDocuments 脚注重编号（引用顺序）', () => {
  const d1 = parse('甲[^a]\n\n[^a]: 甲注');
  const d2 = parse('乙[^b]\n\n[^b]: 乙注');
  const merged = mergeDocuments(d1, d2);
  // 遍历引用节点编号应为 1、2（跨文档连续）
  const numbers = [];
  const walk = (node) => {
    if (node instanceof FootnoteRef) numbers.push(node.number);
    for (const attr of ['content', 'children', 'blocks', 'items']) {
      if (Array.isArray(node[attr])) node[attr].forEach(walk);
    }
  };
  merged.blocks.forEach(walk);
  assert.deepEqual(numbers, [1, 2]);
});

test('mergeDocuments 同名脚注后者覆盖', () => {
  const d1 = parse('[^x]: 旧注');
  const d2 = parse('[^x]: 新注');
  const merged = mergeDocuments(d1, d2);
  assert.equal(merged.footnotes.x, '新注');
});

test('parseText 便捷方法', () => {
  const parser = new Parser();
  const doc = parser.parseText('# 标题');
  assert.ok(doc instanceof Document);
  assert.ok(doc.blocks[0] instanceof Heading);
});
