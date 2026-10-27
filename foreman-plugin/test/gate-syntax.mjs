/**
 * gate-syntax：对 M2 改动的 JS/mjs 逐个做 node --check。
 * argv 内部仍无 shell；由插件 gate 执行器以 node test/gate-syntax.mjs 运行。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = [
  'index.js',
  'src/host/gate.mjs',
  'src/host/store.mjs',
  'src/host/roster.mjs',
  'src/host/challenge.mjs',
  'src/host/project.mjs',
  'src/host/guard.mjs',
  'src/host/archive.mjs',
  'src/host/reputation.mjs',
  'src/host/shared-lessons.mjs',
  'src/host/foreman.mjs',
  'src/host/api.mjs',
  'src/host/brief.mjs',
  'client.js',
  'src/client/ui.mjs',
  'src/build.mjs',
  'test/smoke.mjs',
  'test/gate-syntax.mjs',
  'test/subprocess-selftest.mjs',
];

let failed = false;
for (const relative of files) {
  const result = spawnSync(process.execPath, ['--check', join(here, '..', relative)], { stdio: 'inherit' });
  if (result.error) {
    console.error(`gate-syntax: ${relative}: ${result.error.message}`);
    failed = true;
  } else if (result.status !== 0) {
    console.error(`gate-syntax: ${relative}: exit ${result.status}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`gate-syntax: ${files.length} files ok`);
