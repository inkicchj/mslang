// 回归对比脚本：默认对比 golden 基线；--save 重新生成基线
// 用法: node scripts/compare-cleanup.mjs [--save]
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { render, dumpAST, Parser } from '../src/index.js';
import { mergeDocuments } from '../src/parser.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'compare-golden.json');

const opts = {
  data: {
    bibliography: {
      doe2020: { number: 1, authors: 'Doe, J.', year: 2020, title: 'Paper', journal: 'JML' },
      smith2019: 'Smith (2019)',
    },
    terms: { '词干提取': { label: 'Stemming', url: 'https://stem.example' } },
  },
  variables: { score: 10, name: 'Alice' },
};

const cases = [
  // 基础块
  ['h1', '# 标题'],
  ['h-num', '# 一、总论\n\n## 二、细论\n\n### 1.1 小节'],
  ['h-set', '@set({ headingNumbering: "1.1" })\n# 引言 {#sec:intro}\n\n## 方法 {#sec:method}\n\n如 @ref("sec:intro") 所述'],
  ['h-set-refnum', '@set({ headingNumbering: "1.1", refNumbering: "一" })\n# 第一章 引言 {#sec:intro}\n\n@ref("sec:intro")'],
  ['p', '普通段落 *斜体* **粗体** ~删除~ `代码`'],
  ['hr', '---'],
  ['quote', '> 引用内容\n> 第二行'],
  ['ul', '- 项目一\n- 项目二\n  - 子项'],
  ['ol', '1. 第一\n2. 第二'],
  ['task', '- [x] 完成\n- [ ] 未完成'],
  ['code', '```js\nconst a = 1;\n```'],
  ['code-indent', '    缩进代码'],
  ['table', '| a | b |\n|---|---|\n| 1 | 2 |\n\n表格说明'],
  ['table-label', '@set({ terms: { t1: "T1" } })\n| a |\n|---|\n| 1 |\n\n{#tbl:data} 数据表'],
  ['align', '::: right\n右对齐内容\n:::'],
  ['footnote', '正文[^1]\n\n[^1]: 脚注内容'],
  ['esc', '\\*不斜体\\* 和 \\[括号\\]'],
  ['link', '[链接文本](https://example.com)'],
  ['img', '![图片](https://example.com/a.png)'],
  ['img-label', '![图](/img.png){#fig:1} 图一'],
  ['color', '==红色=='],
  ['sup-sub', 'x^2^ 和 H~2~O'],
  ['html', '<b>原始HTML</b>'],
  ['raw-text', '普通文本 混合@符号 和 $符号'],
  ['break', '第一行\n第二行'],
  // 表达式
  ['expr-var', '@if(score > 5, "高", "低")'],
  ['expr-str', '@if(true, "a)b(c", "x")'],
  ['expr-arith', '@if(1+2*3 == 7 && !(2>3), "ok", "no")'],
  ['expr-arr', '@if(true, ["a", "b", 3], [])'],
  ['expr-obj', '@if(true, {a: 1, "词干": 2}, {})'],
  ['expr-nested', '@if(true, if(false, "a", "b"), "c")'],
  ['expr-short', '@if(false && cite("x"), "a", "b")'],
  // 内置函数
  ['cite', '如 @cite("doe2020") 所示'],
  ['cite-missing', '@if(has_cite("nope"), cite("nope"), "fallback")'],
  ['term', '术语 @term("词干提取")'],
  ['term-str', '@set({ terms: { 缩写: "全称" } })\n@term("缩写")'],
  ['term-unknown', '@term("未知术语")'],
  ['bib', '@cite("doe2020") 与 @cite("smith2019")\n\n@bibliography()'],
  ['set-merge', '@set({ terms: { a: "A" } })\n@set({ terms: { b: "B" } })\n@term("a") @term("b")'],
  ['set-top', '@set({ headingNumbering: "1.1" })\n# X {#s}\n\n@if(1 == 1, "yes", "no")'],
  ['unknown-fn', '@f(1, name="a", 2+3)'],
  ['err-expr', '@if(, "a", "b")'],
  ['expr-empty-call', '@if(true, "ok", "bad")'],
  // 嵌套与组合
  ['nest-bold-cite', '**重点 @cite("doe2020") 内容**'],
  ['nest-quote-cite', '> 引用 @cite("doe2020")\n>\n> 继续'],
  ['nest-list-term', '- 列表 @term("词干提取")\n- 第二项'],
  ['ref-fig', '![图](/a.png){#fig:a}\n\n见图 @ref("fig:a")'],
  ['ref-tbl', '| a |\n|---|\n| 1 |\n\n{#tbl:t} 表\n\n见表 @ref("tbl:t")'],
  ['ref-sec', '## 方法 {#sec:m}\n\n见 @ref("sec:m")'],
  ['ref-unknown', '见 @ref("sec:none")'],
  ['cite-order', '@cite("smith2019") 先 @cite("doe2020") 后'],
  ['multiline', '# 大标题\n\n段落一 **加粗**\n\n段落二 *斜体*'],
];

const out = {};
const stripMeta = (html) => html
  .replace(/ data-(?:cite-key|cite-index|term-key|ref-label|ref-kind)="[^"]*"/g, '')
  // 代码高亮为新增特性：剥 hljs span/class 使旧用例对比保持零 diff
  .replace(/<span class="hljs-[^"]*">/g, '')
  .replace(/<\/span>/g, '')
  .replace(/ class="hljs( language-[^"]*)?"/g, '')
  .replace(/<style>[\s\S]*?<\/style>\n/g, ''); // 内联 CSS（公式/高亮）不在回归对比范围
for (const [name, src] of cases) {
  const html = stripMeta(render(src, opts));
  const ast = dumpAST(new Parser().parseText(src));
  out[name] = { html, ast };
}

// 异步渲染（内置函数全部同步，结果应与同步一致）
const asyncDoc = '@cite("doe2020") 与 @term("词干提取")';
out['async-same'] = { html: stripMeta(await render(asyncDoc, { ...opts, async: true })), ast: '' };

if (process.argv.includes('--save')) {
  writeFileSync(GOLDEN, JSON.stringify(out, null, 2) + '\n');
  console.log(`✅ golden 已保存: ${GOLDEN}（${Object.keys(out).length} 用例）`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  console.error(`❌ 缺少 golden 基线 ${GOLDEN}；先运行: node scripts/compare-cleanup.mjs --save`);
  process.exit(1);
}
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
let same = 0, diff = 0;
for (const k of Object.keys(out)) {
  if (JSON.stringify(golden[k]) === JSON.stringify(out[k])) same++;
  else {
    diff++;
    console.log(`=== DIFF: ${k} ===`);
    console.log(`  golden: ${JSON.stringify(golden[k]).slice(0, 200)}`);
    console.log(`  now   : ${JSON.stringify(out[k]).slice(0, 200)}`);
  }
}
console.log(`same: ${same}, diff: ${diff}, total: ${Object.keys(out).length}`);
process.exit(diff ? 1 : 0);
