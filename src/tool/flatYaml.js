'use strict';

// Tool 层：扁平 YAML "key: value" 解析。
// 只做语法解析，不做语义校验（open_id 格式由 validate 层负责）。
// 畸形行直接抛错，不静默跳过。

function parseFlatYamlMap(src, inputName) {
  const map = {};
  if (!src || !src.trim()) return map;
  src.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`${inputName} line ${i + 1} is not "key: value": ${line}`);
    }
    const key = line.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
    // 剥引号与行尾 " # 注释"（# 前需有空白，与 YAML 一致）。
    const value = line.slice(idx + 1).replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!key) throw new Error(`${inputName} line ${i + 1}: empty key`);
    if (!value) throw new Error(`${inputName} line ${i + 1}: empty value`);
    map[key] = value;
  });
  return map;
}

export { parseFlatYamlMap };
