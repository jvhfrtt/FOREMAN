/**
 * M4 Archivist：bug ledger + 复发指纹 + LESSONS.md。
 * 所有写入走 .foreman/archive.json 的原子写；LESSONS.md 是可读投影。
 */
import {
  appendDecision,
  emptyArchive,
  paths,
  readJson,
  writeJson,
  writeText,
} from './store.mjs';

const STATUSES = ['open', 'fixed', 'wontfix'];
const ARCHIVE_FIELDS = ['area', 'symptom', 'repro', 'rootCause', 'fix', 'regressionGuard'];

export async function readArchiveStore(root) {
  const store = await readJson(paths(root).archive, null);
  if (!store || !Array.isArray(store.entries)) return emptyArchive();
  return {
    version: store.version || 1,
    next: typeof store.next === 'number' ? store.next : store.entries.length + 1,
    entries: store.entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.fingerprint === 'string'),
  };
}

function findEntry(store, { id, cardId, fingerprint }) {
  if (id) return store.entries.find((entry) => entry.id === id) || null;
  if (cardId && fingerprint) {
    return store.entries.find((entry) => entry.cardId === cardId && entry.fingerprint === fingerprint) || null;
  }
  return null;
}

export async function rememberArchive(root, { cardId, fingerprint, ...fields }) {
  const fp = String(fingerprint || '').trim();
  if (!fp) return { ok: false, error: 'remember 必须提供 fingerprint。' };
  const store = await readArchiveStore(root);
  const now = Date.now();
  const existing = findEntry(store, { cardId, fingerprint: fp });
  if (existing) {
    existing.seenCount = (existing.seenCount || 1) + 1;
    existing.lastSeen = now;
    for (const field of ARCHIVE_FIELDS) {
      if (typeof fields[field] === 'string' && fields[field].trim()) existing[field] = fields[field].trim();
    }
    const recurrence = existing.status === 'fixed' || existing.status === 'wontfix';
    if (recurrence) {
      existing.status = 'open';
      // M7.12：复发重开后必须清掉上一轮的解决元数据，避免把“已重开”误读成“已解决”。
      existing.resolvedAt = null;
      existing.resolvedBy = null;
      existing.decision = null;
    }
    await writeJson(paths(root).archive, store);
    await writeLessons(root, store.entries);
    return { ok: true, existing: true, recurrence, entry: existing };
  }
  const entry = {
    id: `A${store.next || 1}`,
    fingerprint: fp,
    area: String(fields.area || '').trim(),
    symptom: String(fields.symptom || '').trim(),
    repro: String(fields.repro || '').trim(),
    rootCause: String(fields.rootCause || '').trim(),
    fix: String(fields.fix || '').trim(),
    regressionGuard: String(fields.regressionGuard || '').trim(),
    status: 'open',
    cardId,
    seenCount: 1,
    firstSeen: now,
    lastSeen: now,
  };
  store.next = (store.next || 1) + 1;
  store.entries = [...store.entries, entry];
  await writeJson(paths(root).archive, store);
  await writeLessons(root, store.entries);
  return { ok: true, existing: false, recurrence: false, entry };
}

export async function resolveArchive(root, { id, cardId, fingerprint, status, by, regressionGuard, fix, rootCause }) {
  if (!STATUSES.includes(status) || status === 'open') {
    return { ok: false, error: 'resolve status 只能是 fixed / wontfix。' };
  }
  const store = await readArchiveStore(root);
  const entry = findEntry(store, { id, cardId, fingerprint });
  if (!entry) return { ok: false, error: '归档条目不存在。' };
  if (entry.status !== 'open') return { ok: false, error: `归档 ${entry.id} 已是 ${entry.status}。` };
  const guard = String(regressionGuard || entry.regressionGuard || '').trim();
  if (status === 'fixed' && !guard) {
    return { ok: false, error: 'status=fixed 必须提供 regressionGuard（回归守卫）。' };
  }
  entry.status = status;
  entry.regressionGuard = guard;
  if (typeof fix === 'string' && fix.trim()) entry.fix = fix.trim();
  if (typeof rootCause === 'string' && rootCause.trim()) entry.rootCause = rootCause.trim();
  entry.resolvedAt = Date.now();
  entry.resolvedBy = by || null;
  await writeJson(paths(root).archive, store);
  await writeLessons(root, store.entries);
  await appendDecision(root, {
    author: 'foreman:archive',
    text: `归档 ${entry.id}（卡 ${entry.cardId}）→ ${status} by ${by || 'unknown'}${guard ? `；guard：${guard}` : ''}`,
  });
  return { ok: true, entry };
}

export async function listArchive(root, { cardId, status = 'open' } = {}) {
  const store = await readArchiveStore(root);
  const entries = store.entries.filter((entry) => (
    (!cardId || entry.cardId === cardId) && (!status || entry.status === status)
  ));
  return { entries, open: entries.filter((entry) => entry.status === 'open') };
}

export async function searchArchive(root, { fingerprint, area, cardId } = {}) {
  const store = await readArchiveStore(root);
  const fp = String(fingerprint || '').trim().toLowerCase();
  const areaText = String(area || '').trim().toLowerCase();
  const entries = store.entries.filter((entry) => (
    (!cardId || entry.cardId === cardId)
    && (!fp || entry.fingerprint.toLowerCase().includes(fp))
    && (!areaText || entry.area.toLowerCase().includes(areaText))
  ));
  return { entries };
}

export async function writeLessons(root, entries) {
  const p = paths(root);
  const lines = ['# LESSONS', '', '> Archivist 自动生成；不要手改。', ''];
  const groups = [
    ['open', 'Open'],
    ['fixed', 'Fixed'],
    ['wontfix', "Won't fix"],
  ];
  for (const [status, label] of groups) {
    const items = entries.filter((entry) => entry.status === status);
    lines.push(`## ${label}（${items.length}）`, '');
    if (!items.length) {
      lines.push('（无）', '');
      continue;
    }
    for (const entry of items) {
      lines.push(`### ${entry.id} · ${entry.fingerprint}`);
      lines.push(`- 卡：${entry.cardId || '—'} ｜ seen ${entry.seenCount || 1}`);
      if (entry.area) lines.push(`- 区域：${entry.area}`);
      if (entry.symptom) lines.push(`- 症状：${entry.symptom}`);
      if (entry.repro) lines.push(`- 复现：${entry.repro}`);
      if (entry.rootCause) lines.push(`- 根因：${entry.rootCause}`);
      if (entry.fix) lines.push(`- 修复：${entry.fix}`);
      if (entry.regressionGuard) lines.push(`- 回归守卫：${entry.regressionGuard}`);
      lines.push('');
    }
  }
  await writeText(p.lessons, `${lines.join('\n')}\n`);
}
