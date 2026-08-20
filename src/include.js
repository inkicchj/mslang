/**
 * 跨文档引用展开（@include）— 文本层预处理，parse 前执行
 *
 * 语法（独占行，参数限字符串字面量）：
 *   @include("path.msl", "part-id")   引用另一文档 @part("part-id", ...) 区间内容
 *
 * 展开规则（用户裁决）：
 *   - 数据通道：仅注入 loader（库零 IO）；loader 同步返回 string 或
 *     返回 Promise（配合 render async:true 异步加载）
 *   - 目标文档递归展开（嵌套 @include），循环引用检测（栈）
 *   - 提取 @part 区间行文本（剥 @part/@end 标记行），剥离块级 @set 行（配置防污染），
 *     @let/@define 保留（内容依赖）
 *   - 失败容错：加载失败/part 缺失 → 占位 HTML 注释 + check issue（missing_include/missing_part）
 *   - SourceMap（0.3）：opts.builder（TextBuilder）逐行记录来源文件，诊断 span 可溯源
 */

import { TextBuilder } from './source-map.js';

const INCLUDE_RE = /^\s*@include\(\s*("(?:\\.|[^"])*")\s*(?:,\s*("(?:\\.|[^"])*")\s*)?\)\s*$/;
const PART_OPEN_RE = /^\s*@part\(\s*("(?:\\.|[^"])*")\s*(?:,\s*("(?:\\.|[^"])*")\s*)?\)\s*$/;
const PART_SETTER_RE = /^\s*@set\(/;

const parseStr = (raw) => JSON.parse(raw);

/** @param {string} text */
function extractPart(text, id, ctx) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PART_OPEN_RE);
    if (m && parseStr(m[1]) === id) { start = i; break; }
  }
  if (start === -1) {
    ctx.issues.push({ type: 'missing_part', key: id, count: 1, block: undefined });
    return `<!-- mslang: 未找到 part "${id}" -->`;
  }
  // 匹配 @end（栈式，支持嵌套 part）；@end 缺失时取到文末
  let depth = 0, end = -1;
  for (let i = start; i < lines.length; i++) {
    if (PART_OPEN_RE.test(lines[i])) depth++;
    if (/^\s*@end\s*$/.test(lines[i])) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const inner = lines.slice(start + 1, end === -1 ? lines.length : end);
  return inner.filter((l) => !PART_SETTER_RE.test(l)).join('\n');
}

/** 展开一份源文本（不写入外部 builder；供 getTarget 提取 part 用） */
function expandTarget(src, opts, stack, cache) {
  const saved = opts.builder;
  delete opts.builder;
  const result = expandIncludes(src, opts, stack, cache);
  opts.builder = saved;
  return result;
}

/** 获取 path 展开后的文本（缓存 + 循环检测 + 递归嵌套展开） */
function getTarget(path, id, opts, ctx) {
  const inStack = ctx.stack.includes(path);
  if (ctx.cache.has(path)) {
    return inStack
      ? `<!-- mslang: 循环引用 @include("${path}") -->`
      : extractPart(ctx.cache.get(path), id, ctx);
  }
  let loaded;
  try { loaded = opts.include(path); } catch (e) { loaded = null; }
  const wrap = (reason) => `<!-- mslang: ${reason} "${path}" -->`;
  const finish = (expanded) => extractPart(expanded, id, ctx);
  if (loaded instanceof Promise) {
    return loaded.then((src) => {
      if (!src) {
        ctx.issues.push({ type: 'missing_include', key: path, count: 1, block: undefined });
        return wrap('include 加载失败');
      }
      ctx.cache.set(path, src);
      return Promise.resolve(expandTarget(src, opts, [...ctx.stack, path], ctx.cache)).then(finish);
    });
  }
  if (!loaded) {
    ctx.issues.push({ type: 'missing_include', key: path, count: 1, block: undefined });
    return wrap('include 加载失败');
  }
  ctx.cache.set(path, loaded);
  if (inStack) return wrap('循环引用 @include');
  const expanded = expandTarget(loaded, opts, [...ctx.stack, path], ctx.cache);
  return expanded instanceof Promise
    ? expanded.then(finish)
    : finish(expanded);
}

/**
 * 展开 source 中的全部 @include 行。
 * loader 全同步时同步返回 string；任一 loader 返回 Promise 时返回 Promise<string>。
 * opts.builder（TextBuilder）提供时逐行记录来源（SourceMap 溯源）。
 * @param {string} source
 * @param {{ include: (path: string) => string|Promise<string>, issues: Array, builder?: TextBuilder, sourceId?: string|null }} opts
 * @param {string[]} [stack] - 当前 include 路径栈（循环检测）
 * @param {Map} [cache] - 已加载文档缓存（同一渲染去重）
 * @returns {string|Promise<string>}
 */
export function expandIncludes(source, opts, stack = [], cache = new Map()) {
  const builder = opts.builder || new TextBuilder(opts.sourceId || null);
  const ctx = {
    stack, issues: opts.issues || [], cache,
    builder, sourceId: opts.sourceId || null,
  };
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(INCLUDE_RE);
    if (!m) { builder.line(lines[i]); continue; }
    const path = parseStr(m[1]);
    const id = m[2] ? parseStr(m[2]) : null;
    if (!id) {
      builder.line('<!-- mslang: @include 需指定 part id（整文档合并请用 render([...])) -->');
      continue;
    }
    const replaced = getTarget(path, id, opts, ctx);
    if (replaced instanceof Promise) {
      // 首个异步信号：剩余行转为异步路径（保持输出顺序）
      return replaced.then((text) => {
        builder.block(text, path);
        return expandIncludes(lines.slice(i + 1).join('\n'), opts, stack, cache);
      });
    }
    builder.block(replaced, path);
  }
  return builder.text;
}
