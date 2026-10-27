/**
 * 把 src/client/ 下的 ESM 拼成浏览器可直接加载的 client.js。
 * 与 bake-lab 同一套做法：去掉模块边界，套上 ModuleLoader 外壳。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['client/ui.mjs'];

const strip = (source) => source
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^export\s+(?=(const|let|var|function|class|async))/gm, '');

const chunks = files.map((name) => {
  const source = strip(readFileSync(join(root, 'src', name), 'utf8'));
  if (/^\s*(import|export)\b/m.test(source)) {
    throw new Error(`${name} still contains a module boundary after stripping`);
  }
  return `    // ── src/${name} ${'─'.repeat(Math.max(2, 46 - name.length))}\n${source}`;
});

const out = `/* 由 src/build.mjs 生成：请改 src/client/ 下的模块，不要直接编辑本文件。 */
window.__ModuleLoader__.load({
  id: '@local/foreman',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
${chunks.join('\n')}
    return createClientModule();
  },
});
`;

writeFileSync(join(root, 'client.js'), out);
console.log(`client.js written: ${out.length} bytes`);
