// 实验性 LaTeX 渲染器（0.3 第七阶段最小版）：验证 AST 独立于 HTML
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLatex, render } from '../src/index.js';

const data = {
  bibliography: {
    doe2020: { authors: 'Doe', year: 2020, title: 'Paper', journal: 'JML' },
  },
};

test('latex：标题/段落/粗斜体/脚注', () => {
  const tex = renderLatex('# 引言 {#sec:intro}\n\n**粗体**与*斜体*[^a]\n\n[^a]: 注释', {});
  assert.match(tex, /\\section\{引言\}\n\\label\{sec:intro\}/);
  assert.match(tex, /\\textbf\{粗体\}/);
  assert.match(tex, /\\textit\{斜体\}/);
  assert.match(tex, /\\footnote\{注释\}/);
});

test('latex：cite/ref/bibliography/term', () => {
  const src = [
    '# 方法 {#sec:m}',
    '',
    '见 @cite("doe2020") 与 @ref("sec:m")，术语 @term("t")。',
    '',
    '@bibliography()',
  ].join('\n');
  const tex = renderLatex(src, {
    data: { ...data, terms: { t: { label: '词干', desc: 'x' } } },
  });
  assert.match(tex, /\\cite\{doe2020\}/);
  assert.match(tex, /\\ref\{sec:m\}/);
  assert.match(tex, /词干/);
  assert.match(tex, /\\begin\{thebibliography\}\{9\}/);
  assert.match(tex, /\\bibitem\{doe2020\} Doe \(2020\) Paper JML/);
});

test('latex：图/表/式/定理', () => {
  const src = [
    '![图](/a.png){#fig:1}',
    '',
    '| a |{#tbl:t}|',
    '|---|',
    '| 1 |',
    '',
    '{#tbl:t} 数据表',
    '',
    '$$E=mc^2$${#eq:x}',
    '',
    '@theorem("thm:1", "主定理")',
    '',
    '结论',
  ].join('\n');
  const tex = renderLatex(src);
  assert.match(tex, /% mslang: 未覆盖 图片/, '行内图片在最小版以注释表示');
  assert.match(tex, /\\begin\{table\}/);
  assert.match(tex, /\\label\{tbl:t\}/);
  assert.match(tex, /\\caption\{数据表\}/);
  assert.match(tex, /\\\[E=mc\^2\\\]/);
  assert.match(tex, /\\label\{eq:x\}/);
  assert.match(tex, /\\begin\{theorem\}/);
  assert.match(tex, /\\label\{thm:1\}/);
});

test('latex：列表与引用块', () => {
  const tex = renderLatex('- 甲\n- 乙\n\n> 引用', {});
  assert.match(tex, /\\begin\{itemize\}/);
  assert.match(tex, /\\item 乙/);
  assert.match(tex, /\\begin\{quote\}/);
});

test('latex：未支持节点输出可读注释（不崩溃）', () => {
  const tex = renderLatex('==红色==\n\n<hr>\n\n```mermaid\nflowchart LR\nA-->B\n````\n', {});
  assert.ok(typeof tex === 'string');
  assert.match(tex, /% mslang/);
});

test('latex：与 HTML 同管线（include/meta 生效）', async () => {
  const src = '@include("ch.msl", "p")\n\n结尾';
  const loader = { include: (p) => '@part("p")\n\n# 引入 {#sec:i}\n\n内容\n\n@end' };
  const tex = renderLatex(src, { include: loader.include });
  assert.match(tex, /\\section\{引入\}/);
  assert.match(tex, /内容/);
  // HTML 渲染不受影响（同管线互补）
  const html = render(src, { include: loader.include });
  assert.match(html, /<h1 id="sec:i">引入<\/h1>/);
});
