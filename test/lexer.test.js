// lexer 词法分析测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer, TokenType } from '../src/index.js';

const tokenize = (src) => new Lexer(src).tokenize();
const types = (src) => tokenize(src).map(t => t.type.name);

test('基础文本', () => {
  assert.deepEqual(types('你好 world'), ['RAW_TEXT', 'EOF']);
});

test('标题 token 与元数据', () => {
  const toks = tokenize('# 标题 {#id}');
  assert.equal(toks[0].type, TokenType.HEADING);
  assert.equal(toks[0].metadata.level, 1);
  assert.equal(toks[0].metadata.id, 'id');
});

test('行内加粗/斜体/下标/代码', () => {
  assert.deepEqual(types('**b** *i* ~s~ `c`'), ['BOLD', 'RAW_TEXT', 'ITALIC', 'RAW_TEXT', 'SUBSCRIPT', 'RAW_TEXT', 'INLINE_CODE', 'EOF']);
});

test('转义：反斜杠剥离', () => {
  const toks = tokenize('\\*不斜体\\*');
  assert.equal(toks[0].type, TokenType.RAW_TEXT);
  assert.equal(toks[0].value, '*不斜体*');
});

test('函数调用 token：name 为值，参数在 raw_args', () => {
  const toks = tokenize('@cite("doe2020")');
  assert.equal(toks[0].type, TokenType.FUNCTION_CALL);
  assert.equal(toks[0].value, 'cite');
  assert.equal(toks[0].metadata.raw_args, '"doe2020"');
});

test('嵌套函数调用括号匹配', () => {
  const toks = tokenize('@if(has_cite("x"), "a", "b")');
  assert.equal(toks[0].type, TokenType.FUNCTION_CALL);
  assert.equal(toks[0].value, 'if');
  assert.equal(toks[0].metadata.raw_args, 'has_cite("x"), "a", "b"');
});

test('图片 label 捕获', () => {
  const toks = tokenize('![图](/a.png){#fig:1}');
  assert.equal(toks[0].type, TokenType.IMAGE);
  assert.equal(toks[0].metadata.label, 'fig:1');
});

test('表格行与分隔行', () => {
  const toks = tokenize('| a | b |\n|---|---|');
  assert.equal(toks[0].type, TokenType.TABLE_ROW);
  assert.equal(toks[1].type, TokenType.LINE_BREAK);
  assert.equal(toks[2].type, TokenType.TABLE_SEP);
});

test('caption token（行首 {#label} 说明）', () => {
  const toks = tokenize('{#fig:1} 实验装置');
  assert.equal(toks[0].type, TokenType.CAPTION);
  assert.equal(toks[0].metadata.label, 'fig:1');
  assert.equal(toks[0].value, '实验装置');
  assert.equal(toks[0].metadata.raw, '{#fig:1} 实验装置');
});

test('行内 {# 不是 caption', () => {
  const toks = tokenize('文本 {#x} 内容');
  assert.equal(toks[0].type, TokenType.RAW_TEXT);
});

test('未闭合反引号回退普通文本', () => {
  const toks = tokenize('`未闭合');
  assert.equal(toks[0].type, TokenType.RAW_TEXT);
});

test('位置信息', () => {
  const toks = tokenize('# 标题');
  assert.equal(toks[0].position.line, 1);
  assert.equal(toks[0].position.col, 1);
});
