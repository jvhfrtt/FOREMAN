/**
 * 监工台的落盘层：全部状态放在被监工项目的 .foreman/ 下。
 * 插件被卸载、换窗口、换人接手，这些文件都还在——这是"一键恢复"的唯一依据。
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export const STATE_VERSION = 1;
export const MAX_EVIDENCE = 400;
export const MAX_TAIL = 4000;

/** 项目根目录：只认绝对路径，避免落到 DSH 自己的 cwd 上。 */
export function resolveRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') return undefined;
  return isAbsolute(root) ? root : resolve(root);
}

export function safeId(id) {
  return String(id || '').trim().replace(/[^A-Za-z0-9._-]/g, '_') || 'unnamed';
}

export function paths(root) {
  const base = join(root, '.foreman');
  return {
    base,
    state: join(base, 'state.json'),
    roster: join(base, 'roster.json'),
    brief: join(base, 'brief.md'),
    decisions: join(base, 'decisions.md'),
    evidence: join(base, 'evidence.json'),
    challenges: join(base, 'challenges.json'),
    archive: join(base, 'archive.json'),
    reputation: join(base, 'reputation.json'),
    bindings: join(base, 'bindings.json'),
    gates: join(base, 'gates.json'),
    lessons: join(root, 'LESSONS.md'),
    cards: join(base, 'cards'),
    card: (id) => join(base, 'cards', `${safeId(id)}.json`),
  };
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

export async function readText(file, fallback = '') {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

/** 先写临时文件再改名，避免半截 JSON 把下一次启动卡死。 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT']);

/**
 * 先写唯一临时文件再 rename；Windows 上杀毒/索引偶发锁住目标文件时重试几次，
 * 避免一次瞬时 EPERM 让整个 gate smoke 崩掉。
 */
async function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      const code = error && error.code;
      if (!RENAME_RETRY_CODES.has(code)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20 * (attempt + 1)));
      if (code === 'ENOENT') await writeFile(tmp, content, 'utf8').catch(() => {});
    }
  }
  throw lastError;
}

export async function writeJson(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeFile(file) {
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeText(file, text) {
  await writeFileAtomic(file, text);
}

export function defaultState(goal) {
  return {
    version: STATE_VERSION,
    goal: goal || '',
    stage: 'idle',
    cardId: null,
    updatedAt: Date.now(),
    seats: {},
    p0: [],
    p1: [],
    lastVerdict: null,
  };
}

export function emptyEvidence() {
  return { version: STATE_VERSION, next: 1, entries: [] };
}

export function emptyChallenges() {
  return { version: 1, next: 1, entries: [] };
}

export function emptyArchive() {
  return { version: 1, next: 1, entries: [] };
}

export function emptyBindings() {
  return { version: 1, bindingSession: null, seatBindings: {}, retired: [] };
}

export function emptyProjectGates() {
  return { version: 1, gates: {} };
}

export async function ensureSkeleton(root, { goal, roster }) {
  const info = await stat(root).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new Error(`项目目录不存在：${root}（config.root 要指向真实存在的项目根目录，插件不会替你创建）`);
  }
  const p = paths(root);
  await mkdir(p.cards, { recursive: true });
  const state = await readJson(p.state, null);
  const next = state || defaultState(goal);
  if (!state) {
    for (const seat of roster) {
      next.seats[seat.id] = { status: 'idle', note: '', at: Date.now(), agentId: seat.agentId || null };
    }
  }
  let changed = !state;
  if (goal && !next.goal) {
    next.goal = goal;
    changed = true;
  }
  for (const seat of roster) {
    if (!next.seats[seat.id]) {
      next.seats[seat.id] = { status: 'idle', note: '', at: Date.now(), agentId: seat.agentId || null };
      changed = true;
    } else if (seat.agentId && next.seats[seat.id].agentId !== seat.agentId) {
      next.seats[seat.id].agentId = seat.agentId;
      changed = true;
    }
  }
  if (Array.isArray(next.p1)) {
    const deduped = dedupeP1(next.p1);
    if (deduped.length !== next.p1.length) {
      next.p1 = deduped;
      changed = true;
    }
  }
  if (changed) {
    next.updatedAt = Date.now();
    await writeJson(p.state, next);
  }
  if (!(await readJson(p.roster, null))) {
    await writeJson(p.roster, roster);
  } else {
    const existingRoster = await readJson(p.roster, []);
    let rosterChanged = false;
    if (Array.isArray(existingRoster)) {
      for (const seat of existingRoster) {
        const configured = roster.find((item) => item.id === seat.id);
        if (configured && configured.agentId && !seat.agentId) {
          seat.agentId = configured.agentId;
          rosterChanged = true;
        }
      }
    }
    if (rosterChanged) await writeJson(p.roster, existingRoster);
  }
  if (!(await readJson(p.evidence, null))) await writeJson(p.evidence, emptyEvidence());
  if (!(await readJson(p.challenges, null))) await writeJson(p.challenges, emptyChallenges());
  if (!(await readJson(p.archive, null))) await writeJson(p.archive, emptyArchive());
  if (!(await readJson(p.bindings, null))) await writeJson(p.bindings, emptyBindings());
  if (!(await readJson(p.gates, null))) await writeJson(p.gates, emptyProjectGates());
  const decisions = await readText(p.decisions, '');
  if (!decisions) {
    await writeText(p.decisions, '# 监工台 · 会议结论与裁决\n\n> 只追加，不改写。每条以 `## 时间 · 来源` 开头。\n');
  }
  return { state: next, roster: await readJson(p.roster, roster), evidence: await readJson(p.evidence, emptyEvidence()) };
}

export async function appendDecision(root, { author, text }) {
  const p = paths(root);
  const stamp = new Date().toISOString();
  const block = `\n## ${stamp} · ${author || 'foreman'}\n\n${String(text || '').trim()}\n`;
  const current = await readText(p.decisions, '# 监工台 · 会议结论与裁决\n');
  await writeText(p.decisions, `${current}${block}`);
  return block.trim();
}

export async function decisionTail(root, count = 6) {
  const text = await readText(paths(root).decisions, '');
  const blocks = text.split(/\n## /).slice(1);
  return blocks.slice(-count).map((block) => `## ${block.trim()}`).join('\n\n');
}

export async function listCards(root) {
  const p = paths(root);
  const state = await readJson(p.state, null);
  const ids = await enumerateCards(root);
  const cards = [];
  for (const id of ids) {
    const card = await readJson(p.card(id), null);
    if (card) cards.push(card);
  }
  cards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { cards, currentId: state && state.cardId ? safeId(state.cardId) : null };
}

async function enumerateCards(root) {
  try {
    const names = await readdir(paths(root).cards);
    return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function normalizeCard(id, input, previous) {
  const scope = input.scope || {};
  const base = previous || {
    id: safeId(id),
    createdAt: Date.now(),
    frozen: false,
    frozenBy: null,
    revise: 0,
    status: 'open',
    note: '',
  };
  return {
    ...base,
    id: safeId(id),
    updatedAt: Date.now(),
    scope: {
      do: takeList(scope.do) ?? (base.scope ? base.scope.do : []),
      not: takeList(scope.not) ?? (base.scope ? base.scope.not : []),
    },
    acceptance: takeList(input.acceptance) ?? base.acceptance ?? [],
    gates: takeList(input.gates) ?? base.gates ?? [],
    artifacts: takeList(input.artifacts) ?? base.artifacts ?? [],
    // M7.16：允许在冻结基线之后变更的相对 root 路径；undefined 表示不启用基线放行名单。
    // M7.17：缺省写成 null，避免 card 对象带 undefined 字段导致工具结果序列化失败。
    allowedFiles: takeList(input.allowedFiles) ?? base.allowedFiles ?? null,
    note: typeof input.note === 'string' ? input.note : base.note || '',
  };
}

function takeList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item)).filter((item) => item.trim() !== '');
}

export function cardSummary(card) {
  if (!card) return '（无）';
  const acceptance = (card.acceptance || []).length;
  return `${card.id}${card.frozen ? '（已冻结）' : ''} · 验收 ${acceptance} 条 · 门禁 ${(card.gates || []).join('/') || '—'}`;
}

export async function fileDigest(root, relative) {
  const abs = isAbsolute(relative) ? relative : join(root, relative);
  const data = await readFile(abs);
  return {
    path: relative,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex').slice(0, 16),
  };
}

export function makeFinding(text, source = 'gate') {
  return { code: source === 'verdict' ? 'P0' : source.toUpperCase(), text: String(text), at: Date.now() };
}

export function dedupeFindings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const text = typeof item === 'string' ? item : item && item.text;
    if (!text) continue;
    const key = String(text).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof item === 'string' ? makeFinding(item, 'verdict') : item);
  }
  return out;
}

/** M5：P1 只按 cardId + text 去重，避免同一卡重复计数；不同卡可保留。 */
export function dedupeP1(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const text = typeof item === 'string' ? item : item && item.text;
    if (!text) continue;
    const cardId = typeof item === 'string' ? '' : (item.cardId || '');
    const key = `${cardId}\0${String(text).trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof item === 'string' ? makeFinding(item, 'verdict') : item);
  }
  return out;
}
