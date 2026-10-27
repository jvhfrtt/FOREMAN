/**
 * M3 Nitpicker 挑战：同一张卡同时只有一个 open challenge。
 * 落 .foreman/challenges.json；所有写入走 store.writeJson（临时文件 + rename）。
 */
import {
  appendDecision,
  emptyChallenges,
  paths,
  readJson,
  writeJson,
} from './store.mjs';

export const CHALLENGE_VERSION = 1;
export const CHALLENGE_DECISIONS = ['cleared', 'blocked'];

export async function readChallengeStore(root) {
  const store = await readJson(paths(root).challenges, null);
  if (!store || !Array.isArray(store.entries)) return emptyChallenges();
  return {
    version: store.version || CHALLENGE_VERSION,
    next: typeof store.next === 'number' ? store.next : store.entries.length + 1,
    entries: store.entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.cardId === 'string'),
  };
}

export function findOpenChallenge(store, cardId) {
  return (store.entries || []).find((entry) => entry.cardId === cardId && entry.status === 'open') || null;
}

export async function listChallenges(root, cardId) {
  const store = await readChallengeStore(root);
  const entries = cardId ? store.entries.filter((entry) => entry.cardId === cardId) : store.entries;
  return { entries, open: entries.filter((entry) => entry.status === 'open') };
}

export async function openChallenge(root, { cardId, by, note, assignedSeat = 'nitpicker' }) {
  const store = await readChallengeStore(root);
  const existing = findOpenChallenge(store, cardId);
  if (existing) return { ok: true, existing: true, challenge: existing };
  const now = Date.now();
  const challenge = {
    id: `C${store.next || 1}`,
    cardId,
    status: 'open',
    assignedSeat,
    openedAt: now,
    openedBy: by || null,
    resolvedAt: null,
    resolvedBy: null,
    decision: null,
    note: String(note || ''),
  };
  store.next = (store.next || 1) + 1;
  store.entries = [...store.entries, challenge];
  await writeJson(paths(root).challenges, store);
  await appendDecision(root, {
    author: 'foreman:challenge',
    text: `开启挑战 ${challenge.id}（卡 ${cardId}）by ${by || 'unknown'}${note ? `：${note}` : ''}`,
  });
  return { ok: true, existing: false, challenge };
}

export async function resolveChallenge(root, { cardId, decision, by, note }) {
  const store = await readChallengeStore(root);
  const challenge = findOpenChallenge(store, cardId);
  if (!challenge) return { ok: false, error: `任务卡 ${cardId} 没有 open challenge。` };
  if (!CHALLENGE_DECISIONS.includes(decision)) {
    return { ok: false, error: `decision 只能是 ${CHALLENGE_DECISIONS.join(' / ')}。` };
  }
  challenge.status = decision;
  challenge.decision = decision;
  challenge.assignedSeat = challenge.assignedSeat || 'nitpicker';
  challenge.resolvedAt = Date.now();
  challenge.resolvedBy = by || null;
  challenge.note = String(note || '');
  await writeJson(paths(root).challenges, store);
  await appendDecision(root, {
    author: 'foreman:challenge',
    text: `关闭挑战 ${challenge.id}（卡 ${cardId}）：${decision} by ${by || 'unknown'}${note ? `：${note}` : ''}`,
  });
  return { ok: true, challenge };
}

export async function waiveChallenge(root, { cardId, by, reason, evidence, note }) {
  const store = await readChallengeStore(root);
  const challenge = findOpenChallenge(store, cardId);
  if (!challenge) return { ok: false, error: `任务卡 ${cardId} 没有 open challenge。` };
  if (!String(reason || '').trim()) return { ok: false, error: 'waive 必须提供 reason。' };
  if (!String(evidence || '').trim()) return { ok: false, error: 'waive 必须提供 evidence（decision/挑战/证据 id）。' };
  challenge.status = 'waived';
  challenge.decision = 'waived';
  challenge.assignedSeat = challenge.assignedSeat || 'nitpicker';
  challenge.resolvedAt = Date.now();
  challenge.resolvedBy = by || null;
  challenge.reason = String(reason).trim();
  challenge.evidence = String(evidence).trim();
  challenge.note = String(note || '');
  await writeJson(paths(root).challenges, store);
  await appendDecision(root, {
    author: 'foreman:challenge',
    text: `主持 waive 挑战 ${challenge.id}（卡 ${cardId}）by ${by || 'host'}；reason：${challenge.reason}；evidence：${challenge.evidence}`,
  });
  return { ok: true, challenge };
}
