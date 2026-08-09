// 回归对比：53 用例输出与 golden 基线一致（行为变更需先 --save 更新基线）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('回归对比：53 用例与 golden 一致', () => {
  const out = execFileSync(process.execPath, ['scripts/compare-cleanup.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /same: 53, diff: 0, total: 53/);
});
