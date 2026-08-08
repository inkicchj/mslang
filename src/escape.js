/**
 * HTML 转义（独立模块：builtin/renderer 共用，避免循环依赖）
 */

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

const ESC_ATTR_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHTML(text) {
  return text.replace(/[&<>]/g, ch => ESC_MAP[ch] || ch);
}

export function escapeAttr(text) {
  return text.replace(/[&<>"']/g, ch => ESC_ATTR_MAP[ch] || ch);
}
