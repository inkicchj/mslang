// CitationEngine：引用格式化适配器 + CSL-JSON 数据模型 + 自动探测 CSL（0.3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.js';
import {
  CitationEngine, detectCSL, normalizeEntry, formatAuthors, entryYear, formatLightweight,
} from '../src/citation.js';

// CSL-JSON 兼容模型条目（重构文档 0.3 数据模型）
const cslBib = {
  smith2024: {
    id: 'smith2024', type: 'article-journal', title: 'On X',
    author: [{ family: 'Smith', given: 'John' }],
    issued: { 'date-parts': [[2024]] },
    'container-title': 'JML', 'volume': '12', 'page': '1-9',
  },
  liu2020: {
    id: 'liu2020', type: 'book', title: '知识螺旋',
    author: [{ family: '刘', given: '明' }],
    issued: { 'date-parts': [[2020, 3]] },
    publisher: 'PUP',
  },
};

test('citation：normalizeEntry 兼容旧模型与 CSL-JSON', () => {
  assert.equal(formatAuthors({ authors: 'Doe' }), 'Doe');
  assert.equal(formatAuthors({ author: [{ family: 'Smith', given: 'John' }] }), 'Smith, J.');
  assert.equal(formatAuthors({ author: [{ family: '刘', given: '明' }] }), '刘明');
  assert.equal(formatAuthors({ author: [{ family: 'Doe', given: 'Jane' }, { family: 'Roe', given: 'R.' }] }), 'Doe, J. and Roe, R.');
  assert.equal(entryYear({ issued: { 'date-parts': [[2024, 3]] } }), 2024);
  assert.equal(entryYear({ year: 1999 }), 1999);
  const n = normalizeEntry(cslBib.smith2024);
  assert.equal(n.authors, 'Smith, J.');
  assert.equal(n.year, 2024);
  assert.equal(n.container, 'JML');
});

test('citation：lightweight 输出 CSL-JSON 条目（default）', () => {
  assert.equal(
    formatLightweight(cslBib.smith2024, 'default'),
    'Smith, J. (2024) On X JML',
  );
});

test('citation：gbt7714 用容器名', () => {
  const out = formatLightweight(cslBib.smith2024, 'gbt7714');
  assert.match(out, /^Smith, J\. On X\. JML, 2024\.$/);
});

test('citation：自动探测 CSL（@citation-js 已安装 devDependencies）', () => {
  const core = detectCSL();
  assert.ok(core && typeof core.Cite === 'function', '应探测到 @citation-js/core');
});

test('citation：自动探测不到时回退 lightweight（style 覆盖为 null）', () => {
  const engine = new CitationEngine({ style: undefined });
  assert.equal(engine.enabled, false);
  assert.equal(engine.formatBibliography({ authors: 'Doe', year: 2020, title: 'T' }), 'Doe (2020) T');
});

test('citation：CSL style 启用后 cite/bibliography 走 citeproc（auto-detect）', () => {
  const ctx = { data: { bibliography: cslBib } };
  const h = render('看 @cite("smith2024")。\n\n@bibliography()', { ...ctx, citation: { style: 'apa', locale: 'en-US' } });
  // cite 内联：citeproc APA 文本（family, given 首字母 + 年份）
  assert.match(h, /\(Smith, 2024\)/);
  // bibliography：csl-entry 文本（标题斜体源在 csl-entry 内部，含 volume/page 明细）
  assert.match(h, /Smith, J\. \(2024\)\. On X\. <i>JML<\/i>/);
});

test('citation：多 key CSL 内联锚点保留 data 元数据', () => {
  const h = render('@cite("smith2024","liu2020")', {
    data: { bibliography: cslBib }, citation: { style: 'apa' },
  });
  assert.match(h, /data-cite-key="smith2024"/);
  assert.match(h, /data-cite-key="liu2020"/);
  assert.match(h, /Smith, 2024/);
});

test('citation：CSL-JSON 中文作者（family=刘, given=明 → 刘明）', () => {
  const h = render('@cite("liu2020")', { data: { bibliography: cslBib }, citation: { style: 'apa' } });
  assert.match(h, /刘明|刘, /);
});

test('citation：escapeHtml 关闭时 lightweight 不转义', () => {
  const out = formatLightweight({ authors: 'A&B', title: 'T<X>' }, 'default', false);
  assert.equal(out, 'A&B T<X>');
});

test('citation：normalize(entries) 批量标准化（文档建议接口）', () => {
  const engine = new CitationEngine({});
  const out = engine.normalize(cslBib);
  assert.equal(out.smith2024.authors, 'Smith, J.');
  assert.equal(out.liu2020.year, 2020);
});
