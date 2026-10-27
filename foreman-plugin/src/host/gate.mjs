/**
 * M2 门禁执行器：只运行由插件 config 注册的 argv，不接受模型传 shell/argv。
 * 真实命令走 DSH ctx.subprocess.spawn；离线 smoke 注入假 subprocess。
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 600000;
export const DEFAULT_GRACE_MS = 3000;
export const MAX_OUTPUT_BYTES = 65536;
export const MAX_TAIL_CHARS = 4000;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/**
 * target 是否在 root 内（含 root 本身）。跨盘符、`..\\` 逃逸都算 root 外。
 * Windows 大小写差异交给 path.relative 处理。
 */
export function isPathInsideRoot(root, target) {
  if (!root || !target) return false;
  const rootPath = resolve(String(root));
  const targetPath = resolve(String(target));
  if (rootPath === targetPath) return true;
  const rel = relative(rootPath, targetPath);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * gate cwd 的 root 绑定校验（M7.3）：
 * - cwd 缺省为 active root，相对 cwd 相对 active root 解析；
 * - 绝对 cwd 默认必须在 active root 内；
 * - 只有显式 allowOutsideRoot: true 的 gate 才允许在 root 外执行。
 * 返回 null 表示可以执行，否则返回明确的拒绝信息。
 */
export function gateCwdIssue(spec, activeRoot) {
  if (!spec || !spec.cwd) {
    return {
      error: `gate ${spec && spec.name ? spec.name : '?'} 没有可用的 cwd，拒绝执行。`,
      root: activeRoot ? resolve(String(activeRoot)) : '',
      cwd: '',
      outsideRoot: true,
      allowOutsideRoot: false,
    };
  }
  if (!activeRoot) return null;
  const root = resolve(String(activeRoot));
  if (isPathInsideRoot(root, spec.cwd)) return null;
  if (spec.allowOutsideRoot === true) return null;
  const location = spec.registry === 'project'
    ? `.foreman/gates.json 的 ${spec.name} 条目`
    : `config.gates.${spec.name}`;
  return {
    error: `gate ${spec.name} 的 cwd 不在当前 active root 内：cwd=${spec.cwd}，root=${root}。`
      + `为避免跨项目假绿，默认拒绝执行（不 spawn、不写证据）；如该 gate 确实必须在 root 外运行`
      + `（例如插件自身测试），请在 ${location} 显式加 allowOutsideRoot: true。`,
    root,
    cwd: spec.cwd,
    outsideRoot: true,
    allowOutsideRoot: false,
  };
}

/** config.gates[name] = { cwd, allowOutsideRoot?, argv, timeoutMs?, graceMs? }；argv 必须是字符串数组。 */
export function normalizeGateRegistry(root, gates) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) return {};
  const base = root ? resolve(String(root)) : process.cwd();
  const out = {};
  for (const [rawName, spec] of Object.entries(gates)) {
    const name = String(rawName || '').trim();
    if (!name || !spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) continue;
    if (!spec.argv.every((part) => typeof part === 'string' && part.length > 0)) continue;
    const cwdSpec = spec.cwd ? String(spec.cwd) : '.';
    const cwd = isAbsolute(cwdSpec) ? resolve(cwdSpec) : resolve(base, cwdSpec);
    out[name] = {
      name,
      registry: 'config',
      root: base,
      cwdSpec,
      cwd,
      allowOutsideRoot: spec.allowOutsideRoot === true,
      outsideRoot: !isPathInsideRoot(base, cwd),
      argv: [...spec.argv],
      testsRoot: typeof spec.testsRoot === 'string' && spec.testsRoot.trim() ? spec.testsRoot.trim() : 'tests',
      artifacts: Array.isArray(spec.artifacts)
        ? spec.artifacts.map((item) => String(item).trim()).filter(Boolean)
        : [],
      timeoutMs: Math.min(MAX_TIMEOUT_MS, positive(spec.timeoutMs, DEFAULT_TIMEOUT_MS)),
      graceMs: positive(spec.graceMs, DEFAULT_GRACE_MS),
    };
  }
  return out;
}

/** 严格校验一个项目本地 gate（.foreman/gates.json）；返回 { ok, spec } 或 { ok:false, error }。 */
function normalizeProjectGateSpec(root, name, spec) {
  const base = root ? resolve(String(root)) : process.cwd();
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, error: 'gate 定义必须是对象。' };
  }
  if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
    return { ok: false, error: 'argv 必须是非空数组。' };
  }
  if (!spec.argv.every((part) => typeof part === 'string' && part.length > 0)) {
    return { ok: false, error: 'argv 必须是字符串数组。' };
  }
  if (spec.cwd !== undefined && (typeof spec.cwd !== 'string' || !spec.cwd.trim())) {
    return { ok: false, error: 'cwd 必须是绝对路径或相对 root 的非空字符串。' };
  }
  if (spec.testsRoot !== undefined && (typeof spec.testsRoot !== 'string' || !spec.testsRoot.trim())) {
    return { ok: false, error: 'testsRoot 必须是非空字符串。' };
  }
  if (spec.allowOutsideRoot !== undefined && typeof spec.allowOutsideRoot !== 'boolean') {
    return { ok: false, error: 'allowOutsideRoot 必须是布尔值。' };
  }
  if (spec.artifacts !== undefined
    && (!Array.isArray(spec.artifacts)
      || !spec.artifacts.every((item) => typeof item === 'string' && item.trim()))) {
    return { ok: false, error: 'artifacts 必须是非空字符串数组（glob，相对 gate cwd）。' };
  }
  if (spec.timeoutMs !== undefined && (!Number.isFinite(Number(spec.timeoutMs)) || Number(spec.timeoutMs) <= 0)) {
    return { ok: false, error: 'timeoutMs 必须是正数。' };
  }
  if (spec.graceMs !== undefined && (!Number.isFinite(Number(spec.graceMs)) || Number(spec.graceMs) <= 0)) {
    return { ok: false, error: 'graceMs 必须是正数。' };
  }
  const cwdSpec = spec.cwd ? String(spec.cwd).trim() : '.';
  const cwd = isAbsolute(cwdSpec) ? resolve(cwdSpec) : resolve(base, cwdSpec);
  return {
    ok: true,
    spec: {
      name,
      registry: 'project',
      root: base,
      cwdSpec,
      cwd,
      allowOutsideRoot: spec.allowOutsideRoot === true,
      outsideRoot: !isPathInsideRoot(base, cwd),
      argv: [...spec.argv],
      testsRoot: spec.testsRoot ? String(spec.testsRoot).trim() : 'tests',
      artifacts: Array.isArray(spec.artifacts)
        ? spec.artifacts.map((item) => String(item).trim()).filter(Boolean)
        : [],
      timeoutMs: Math.min(MAX_TIMEOUT_MS, positive(spec.timeoutMs, DEFAULT_TIMEOUT_MS)),
      graceMs: positive(spec.graceMs, DEFAULT_GRACE_MS),
    },
  };
}

/**
 * 读取 .foreman/gates.json（已 JSON.parse）：支持 { version, gates: {name: spec} } 或
 * { version, gates: [{ name, argv, ... }] }。返回 { gates, invalid, error }。
 */
export function normalizeProjectGateRegistry(root, raw) {
  const empty = { gates: {}, invalid: {}, error: '' };
  if (raw === null || raw === undefined) return empty;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, error: '.foreman/gates.json 顶层必须是对象：{ version, gates }。' };
  }
  const source = raw.gates;
  if (source === undefined) {
    return { ...empty, error: '.foreman/gates.json 缺少 gates 字段。' };
  }
  const entries = [];
  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        entries.push([null, item]);
        continue;
      }
      entries.push([String(item.name || '').trim(), item]);
    }
  } else if (source && typeof source === 'object') {
    entries.push(...Object.entries(source));
  } else {
    return { ...empty, error: '.foreman/gates.json 的 gates 必须是对象或数组。' };
  }
  const gates = {};
  const invalid = {};
  for (const [rawName, spec] of entries) {
    const name = String(rawName || '').trim();
    if (!name) {
      invalid['<unnamed>'] = '存在缺少 name 的 gate 定义。';
      continue;
    }
    const result = normalizeProjectGateSpec(root, name, spec);
    if (!result.ok) {
      invalid[name] = result.error;
      continue;
    }
    gates[name] = result.spec;
  }
  return { gates, invalid, error: '' };
}

export function gateSpecFromConfig(registry, name) {
  return registry && Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : null;
}

export function resolveGateTimeout(spec, requested) {
  if (requested === undefined || requested === null || requested === '') {
    return spec.timeoutMs || DEFAULT_TIMEOUT_MS;
  }
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(value));
}

export function displayCommand(argv) {
  return (argv || []).map((part) => {
    const text = String(part);
    return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
  }).join(' ');
}

const CODE_EXCLUDES = new Set(['node_modules', '.git', 'dist', '.foreman', '.vite-cache']);
const CODE_FILE_EXCLUDES = new Set(['LESSONS.md']);

async function codeFilesUnder(dir, base = '') {
  let entries;
  try {
    entries = await readdir(join(dir, base), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (CODE_EXCLUDES.has(entry.name)) continue;
      files.push(...await codeFilesUnder(dir, join(base, entry.name)));
    } else if (entry.isFile()) {
      if (CODE_FILE_EXCLUDES.has(entry.name)) continue;
      files.push(join(base, entry.name));
    }
  }
  return files;
}

/** 当前 gate cwd 的源码/配置/测试摘要；排除依赖、VCS、构建产物和 .foreman。 */
export async function snapshotCode(root) {
  const files = await codeFilesUnder(root);
  const hash = createHash('sha256');
  const entries = [];
  for (const relative of files) {
    const content = await readFile(join(root, relative));
    const digest = createHash('sha256').update(content).digest('hex');
    entries.push({ path: relative.replace(/\\/g, '/'), sha256: digest, bytes: content.length });
    hash.update(relative.replace(/\\/g, '/')).update('\0').update(digest).update('\n');
  }
  return { hash: hash.digest('hex'), files: entries.length, entries };
}

export function gateSpecHash(spec) {
  return createHash('sha256').update(JSON.stringify({
    root: spec.root || '',
    registry: spec.registry || '',
    cwd: spec.cwd,
    allowOutsideRoot: spec.allowOutsideRoot === true,
    argv: spec.argv,
    testsRoot: spec.testsRoot,
    artifacts: spec.artifacts || [],
  })).digest('hex');
}

async function filesUnder(dir, base = '') {
  let entries;
  try {
    entries = await readdir(join(dir, base), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = join(base, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(dir, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/** 对 gate 指定的测试目录做内容快照；testsRoot 相对 gate cwd，默认 tests。 */
export async function snapshotTests(root, testsRoot = 'tests') {
  const testsDir = isAbsolute(testsRoot) ? testsRoot : resolve(root, testsRoot);
  let info;
  try {
    info = await stat(testsDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`testsRoot 不存在：${testsDir}`);
    throw new Error(`testsRoot 不可读：${testsDir}（${error && error.message ? error.message : String(error)}）`);
  }
  if (!info.isDirectory()) throw new Error(`testsRoot 不是目录：${testsDir}`);
  const files = await filesUnder(testsDir);
  const hash = createHash('sha256');
  const entries = [];
  for (const relative of files) {
    const content = await readFile(join(testsDir, relative));
    const digest = createHash('sha256').update(content).digest('hex');
    entries.push({ path: relative.replace(/\\/g, '/'), sha256: digest, bytes: content.length });
    hash.update(relative.replace(/\\/g, '/')).update('\0').update(digest).update('\n');
  }
  return { hash: hash.digest('hex'), files: entries, testsDir };
}

function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `…（已截断，保留尾部 ${max} 字符）\n${value.slice(-max)}`;
}

function readCollected(child, stream) {
  try {
    const reader = child && child.collected && child.collected[stream];
    if (!reader || typeof reader.readFrom !== 'function') return '';
    return String(reader.readFrom(0).text || '');
  } catch {
    return '';
  }
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

/**
 * 运行一个注册门禁。失败/超时/异常都返回结果对象，不在这里写状态。
 * 超时使用 terminate() kill，exitCode 记为 null；调用方负责 P0。
 */
export async function runGateCommand(subprocess, spec, { timeoutMs, graceMs } = {}) {
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    return {
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
      stdout: '',
      stderr: 'subprocess 服务不可用',
      error: 'subprocess 服务不可用',
    };
  }
  const effectiveTimeout = resolveGateTimeout(spec, timeoutMs);
  if (effectiveTimeout === null) {
    return {
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
      stdout: '',
      stderr: 'timeoutMs 必须是正数',
      error: 'timeoutMs 必须是正数',
    };
  }
  const effectiveGrace = positive(graceMs, spec.graceMs || DEFAULT_GRACE_MS);
  const started = Date.now();
  let child;
  try {
    child = subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: effectiveGrace,
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      durationMs: Date.now() - started,
      timedOut: false,
      stdout: '',
      stderr: error && error.message ? error.message : String(error),
      error: error && error.message ? error.message : String(error),
    };
  }

  let timer;
  let timedOut = false;
  let outcome = null;
  let error = null;
  const timeoutMarker = Symbol('timeout');
  try {
    outcome = await Promise.race([
      Promise.resolve(child.done).catch((reason) => {
        error = reason;
        return null;
      }),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(timeoutMarker), effectiveTimeout);
      }),
    ]);
    if (outcome === timeoutMarker) {
      timedOut = true;
      try {
        child.terminate();
      } catch {
        /* 进程已退出 */
      }
      try {
        await Promise.race([
          Promise.resolve(child.done).catch(() => null),
          wait(effectiveGrace),
        ]);
      } catch {
        /* ignore */
      }
    }
  } catch (reason) {
    error = reason;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const stdout = readCollected(child, 'stdout');
  const stderr = readCollected(child, 'stderr');
  const exitCode = timedOut || !outcome ? null : (typeof outcome.exitCode === 'number' ? outcome.exitCode : null);
  return {
    exitCode,
    signal: timedOut || !outcome ? null : (outcome.signal || null),
    durationMs: Date.now() - started,
    timedOut,
    stdout,
    stderr,
    tail: truncate([stdout, stderr].filter(Boolean).join('\n'), MAX_TAIL_CHARS),
    stdoutTail: truncate(stdout, MAX_TAIL_CHARS),
    stderrTail: truncate(stderr, MAX_TAIL_CHARS),
    error: error ? (error.message ? error.message : String(error)) : (timedOut ? '门禁执行超时' : null),
  };
}

/* ---------- M7.18：gate artifacts 收集 ---------- */

/** 把 glob 段编译成正则：** 匹配任意多段，* 匹配一段内任意字符，? 匹配单个字符。 */
function globRegex(segments) {
  let out = '^';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === '**') {
      out += i === segments.length - 1
        ? '(?:[^/]+(?:/[^/]+)*)?'
        : '(?:[^/]+/)*';
    } else if (segment.includes('*') || segment.includes('?')) {
      out += segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    } else {
      out += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    if (i < segments.length - 1 && segment !== '**') out += '/';
  }
  out += '$';
  return new RegExp(out);
}

/**
 * M7.18：收集 gate 产物。patterns 是相对 gate cwd 的 glob（如 'dist/**'）。
 * 匹配文件登记为 { path, sha256, bytes }，path 相对 root；
 * pattern 不匹配或目录不存在都不报错；单条 pattern 失败不影响其他。
 */
export async function collectArtifacts(root, cwd, patterns) {
  const list = Array.isArray(patterns)
    ? patterns.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!list.length) return [];
  const pathRoot = resolve(String(root || cwd || process.cwd()));
  const baseRoot = resolve(String(cwd || root || process.cwd()));
  const collected = new Map();

  for (const raw of list) {
    try {
      const pattern = raw.replace(/\\/g, '/');
      if (!pattern) continue;
      const segments = pattern.split('/').filter(Boolean);
      if (!segments.length) continue;
      const staticSegments = [];
      let hasWildcard = false;
      for (const segment of segments) {
        if (segment === '**' || segment.includes('*') || segment.includes('?')) {
          hasWildcard = true;
          break;
        }
        staticSegments.push(segment);
      }
      const baseDir = resolve(baseRoot, ...staticSegments);

      if (!hasWildcard) {
        try {
          const content = await readFile(baseDir);
          const digest = createHash('sha256').update(content).digest('hex');
          collected.set(baseDir, {
            path: relative(pathRoot, baseDir).replace(/\\/g, '/'),
            sha256: digest.slice(0, 16),
            bytes: content.length,
          });
        } catch {
          /* 文件不存在不报错 */
        }
        continue;
      }

      let info;
      try {
        info = await stat(baseDir);
      } catch {
        continue; /* 静态前缀目录不存在不报错 */
      }
      if (!info.isDirectory()) continue;
      const regex = globRegex(segments);
      const files = await filesUnder(baseDir);
      for (const rel of files) {
        const relPath = rel.replace(/\\/g, '/');
        const full = [...staticSegments, ...relPath.split('/').filter(Boolean)];
        if (!regex.test(full.join('/'))) continue;
        const abs = join(baseDir, rel);
        if (collected.has(abs)) continue;
        const content = await readFile(abs);
        const digest = createHash('sha256').update(content).digest('hex');
        collected.set(abs, {
          path: relative(pathRoot, abs).replace(/\\/g, '/'),
          sha256: digest.slice(0, 16),
          bytes: content.length,
        });
      }
    } catch {
      /* 单条 pattern 失败不影响其他 */
    }
  }
  return [...collected.values()].sort((a, b) => a.path.localeCompare(b.path));
}
