/**
 * ast-utils.js — AST 遍历工具（纯模块，不依赖 parser/renderer）。
 * normalize / semantic / mergeDocuments 共用。
 */

/**
 * 深度遍历 AST 节点（递归穿过 content/children/blocks/items 数组属性）。
 * @param {object} node
 * @param {(node: object) => void} fn
 */
export function walkNodes(node, fn) {
  fn(node);
  for (const attr of ['content', 'children', 'blocks', 'items']) {
    const children = node[attr];
    if (Array.isArray(children)) {
      for (const child of children) walkNodes(child, fn);
    }
  }
}
