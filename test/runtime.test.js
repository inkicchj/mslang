// runtime 层 contract tests：变量/配置/插件锁（不测 HTML）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext, SET_KEYS } from '../src/runtime.js';

test('RuntimeContext：@let 应用 + @set 配置合并', () => {
  const rt = new RuntimeContext({});
  rt.resetHost({ headingNumbering: '1', data: { bibliography: { a: {} } } });
  rt.applyLet({ error: '', args: [{ type: 'string', value: 'x' }, { type: 'number', value: 5 }] });
  assert.equal(rt.variables.x, 5);
  // merge 路径（terms/bibliography 深合并）
  rt.applySetConfig({ terms: { AI: '智' }, citeStyle: 'author-year' });
  assert.equal(rt.data.terms.AI, '智');
  assert.equal(rt.citeStyle, 'author-year');
  // 二次增量合并
  rt.applySetConfig({ terms: { ML: '机器学习' } });
  assert.equal(rt.data.terms.AI, '智');
  assert.equal(rt.data.terms.ML, '机器学习');
});

test('RuntimeContext：配置优先级 Host > @set > Defaults', () => {
  // 宿主显式构造 escapeHtml:false → @set 不可覆盖（host 锁）
  const rt = new RuntimeContext({ escapeHtml: false });
  rt.resetHost({ headingNumbering: '1' });
  rt.applySetConfig({ headingNumbering: '2', escapeHtml: true });
  assert.equal(rt.headingNumbering, '2', '非 host 键 @set 覆盖默认');
  assert.equal(rt.escapeHtml, false, '宿主显式 escapeHtml 锁：@set 不可覆盖');
  // 宿主未显式时 @set 可调（文档 @set({escapeHtml:false}) 仍工作）
  const rt2 = new RuntimeContext({});
  rt2.resetHost({});
  rt2.applySetConfig({ escapeHtml: false });
  assert.equal(rt2.escapeHtml, false);
});

test('RuntimeContext：allowPlugins 默认 false，文档 @set 无法打开', () => {
  const rt = new RuntimeContext({});
  rt.resetHost({});
  assert.equal(rt.allowPlugins, false, '默认关闭');
  rt.applySetConfig({ allowPlugins: true });
  assert.equal(rt.allowPlugins, false, 'host 锁：文档不能打开');
  const rt2 = new RuntimeContext({});
  rt2.resetHost({ allowPlugins: true });
  assert.equal(rt2.allowPlugins, true, '宿主显式开启生效');
});

test('SET_KEYS 白名单含安全键', () => {
  assert.ok(SET_KEYS.includes('allowPlugins'));
  assert.ok(SET_KEYS.includes('headingNumbering'));
});
