/**
 * HTML 转义 + URL 安全（独立模块：builtin/renderer/citation 共用，避免循环依赖）
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

// URL 白名单：链接与图片分开规则（渲染/引用链接共用）。
// 链接：相对路径（#、/、./、../）或 http/https/mailto/ftp；
// 图片：相对路径、data:image/、blob:、http/https。
// 未命中白名单的协议（javascript:/data: 非图片等）拒绝（输出空 href/src）。
export function safeLinkUrl(value) {
  const url = String(value == null ? '' : value).trim();
  if (!url) return '';
  if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (['http:', 'https:', 'mailto:', 'ftp:'].includes(parsed.protocol)) return url;
  } catch { /* 无法解析即拒绝 */ }
  return '';
}

export function safeImageUrl(value) {
  const url = String(value == null ? '' : value).trim();
  if (!url) return '';
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url;
  if (/^data:image\//i.test(url)) return url;
  if (/^blob:/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol)) return url;
  } catch { /* 无法解析即拒绝 */ }
  return '';
}
