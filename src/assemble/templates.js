'use strict';

// 装配层：{{token}} 模板渲染。
// 未知 token 直接抛错并列出可用 token，不静默留空。

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

// 字符串模板：所有变量必须是字符串（用于 title）。
function renderString(template, vars) {
  return template.replace(TOKEN_RE, (raw, key) => {
    if (!(key in vars)) {
      throw new Error(`unknown template variable "{{${key}}}", available: ${Object.keys(vars).join(', ')}`);
    }
    return vars[key];
  });
}

// 富文本模板：一行一个段落，token 解析为飞书元素（text/a/at），
// 其余文本片段解析为 text 元素（用于 post content）。
function renderElements(template, resolvers) {
  return template
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const elements = [];
      let last = 0;
      for (const match of line.matchAll(TOKEN_RE)) {
        const [raw, key] = match;
        if (!(key in resolvers)) {
          throw new Error(`unknown template token "{{${key}}}", available: ${Object.keys(resolvers).join(', ')}`);
        }
        if (match.index > last) elements.push({ tag: 'text', text: line.slice(last, match.index) });
        elements.push(...resolvers[key]());
        last = match.index + raw.length;
      }
      if (last < line.length) elements.push({ tag: 'text', text: line.slice(last) });
      return elements;
    });
}

export { renderString, renderElements };
