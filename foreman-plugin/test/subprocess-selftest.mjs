/**
 * 真实子进程 runner 自测：把 node:child_process 适配成 ctx.subprocess 形状，
 * 跑 node -e exit0/exit2 与 sleep+timeout；不启动 Harness。
 */
import { spawn } from 'node:child_process';
import { runGateCommand } from '../src/host/gate.mjs';

function createAdapter() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      const reader = (get) => ({ readFrom: () => ({ text: get(), nextOffset: Buffer.byteLength(get()), lossy: false }) });
      return {
        stdin: null,
        stdout: null,
        stderr: null,
        control: null,
        collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
        done,
        terminate: () => { try { child.kill(); } catch { /* already gone */ } },
        waitForExit: async () => true,
      };
    },
  };
}

let failed = 0;
const assert = (condition, message) => {
  if (!condition) {
    failed += 1;
    console.error(`BAD  ${message}`);
    return;
  }
  console.log(`ok   ${message}`);
};

const adapter = createAdapter();
const cwd = process.cwd();

const ok = await runGateCommand(adapter, {
  argv: [process.execPath, '-e', "process.stdout.write('real-ok'); process.exit(0)"],
  cwd,
}, { timeoutMs: 5000, graceMs: 500 });
assert(ok.exitCode === 0 && ok.stdout.includes('real-ok'), '真实 runner exit0 + collected stdout');
assert(ok.durationMs >= 0 && ok.error === null, '真实 runner duration/error');

const failedRun = await runGateCommand(adapter, {
  argv: [process.execPath, '-e', "process.stderr.write('real-bad'); process.exit(2)"],
  cwd,
}, { timeoutMs: 5000, graceMs: 500 });
assert(failedRun.exitCode === 2 && failedRun.stderr.includes('real-bad'), '真实 runner exit2 + collected stderr');

const timed = await runGateCommand(adapter, {
  argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
  cwd,
}, { timeoutMs: 200, graceMs: 500 });
assert(timed.timedOut === true && timed.exitCode === null, '真实 runner 超时 exitCode=null');
assert(timed.durationMs >= 150 && timed.durationMs < 3000, '真实 runner 超时不挂起');

if (failed > 0) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log('REAL SUBPROCESS PASS');
