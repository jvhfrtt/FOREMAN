/**
 * M5 信誉账本：每席 score / trust / events。
 * 分数变化必须有 reason + evidence；初始 70，边界 0-100。
 */
import { paths, readJson, writeJson } from './store.mjs';

export const INITIAL_SCORE = 70;
export const MIN_SCORE = 0;
export const MAX_SCORE = 100;
export const TRUST_LEVELS = [
  { min: 85, trust: 'high' },
  { min: 60, trust: 'normal' },
  { min: 40, trust: 'watch' },
  { min: 0, trust: 'breaker' },
];
const MAX_EVENTS = 300;

export function trustFor(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'normal';
  if (value >= 85) return 'high';
  if (value >= 60) return 'normal';
  if (value >= 40) return 'watch';
  return 'breaker';
}

export function emptyReputation(roster = []) {
  const seats = {};
  for (const seat of roster) {
    seats[seat.id] = { score: INITIAL_SCORE, trust: trustFor(INITIAL_SCORE), events: [] };
  }
  return { version: 1, next: 1, seats };
}

function normalizeStore(store, roster) {
  const base = store && typeof store === 'object' ? store : emptyReputation(roster);
  const seats = {};
  for (const seat of roster) {
    const current = base.seats && base.seats[seat.id] ? base.seats[seat.id] : null;
    const score = current && Number.isFinite(Number(current.score))
      ? Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(Number(current.score))))
      : INITIAL_SCORE;
    seats[seat.id] = {
      score,
      trust: trustFor(score),
      events: Array.isArray(current && current.events) ? current.events.slice(-MAX_EVENTS) : [],
    };
  }
  return {
    version: 1,
    next: typeof base.next === 'number' ? base.next : 1,
    seats,
  };
}

export async function ensureReputation(root, roster) {
  const store = await readJson(paths(root).reputation, null);
  const next = normalizeStore(store, roster);
  const changed = !store
    || JSON.stringify(store) !== JSON.stringify(next);
  if (changed) await writeJson(paths(root).reputation, next);
  return next;
}

export async function readReputation(root, roster) {
  const store = await readJson(paths(root).reputation, null);
  return normalizeStore(store, roster);
}

export async function adjustReputation(root, roster, { seat, type, delta, reason, evidence, by, cardId }) {
  if (!['award', 'penalize'].includes(type)) {
    return { ok: false, error: 'type 只能是 award / penalize。' };
  }
  if (!roster.some((item) => item.id === seat)) return { ok: false, error: `未知席位：${seat}` };
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'delta 必须是正数。' };
  if (!String(reason || '').trim()) return { ok: false, error: '必须提供 reason。' };
  if (!String(evidence || '').trim()) return { ok: false, error: '必须提供 evidence（archive/gate/challenge/decision id）。' };

  const store = await readReputation(root, roster);
  const current = store.seats[seat];
  const scoreBefore = current.score;
  const signed = type === 'award' ? Math.abs(Math.round(amount)) : -Math.abs(Math.round(amount));
  const scoreAfter = Math.max(MIN_SCORE, Math.min(MAX_SCORE, scoreBefore + signed));
  const event = {
    id: `R${store.next || 1}`,
    type,
    delta: scoreAfter - scoreBefore,
    requestedDelta: signed,
    scoreBefore,
    scoreAfter,
    trustBefore: trustFor(scoreBefore),
    trustAfter: trustFor(scoreAfter),
    reason: String(reason).trim(),
    evidence: String(evidence).trim(),
    cardId: cardId || null,
    by: by || null,
    at: Date.now(),
  };
  store.next = (store.next || 1) + 1;
  current.score = scoreAfter;
  current.trust = trustFor(scoreAfter);
  current.events = [...current.events, event].slice(-MAX_EVENTS);
  await writeJson(paths(root).reputation, store);
  return { ok: true, seat, score: scoreAfter, trust: current.trust, event, entry: current };
}

export async function listReputation(root, roster, seat) {
  const store = await readReputation(root, roster);
  if (seat) {
    if (!store.seats[seat]) return { ok: false, error: `未知席位：${seat}` };
    return { ok: true, seats: { [seat]: store.seats[seat] }, seat };
  }
  return { ok: true, seats: store.seats };
}

export function breakersFrom(reputation, roster) {
  return roster
    .filter((seat) => reputation.seats[seat.id] && reputation.seats[seat.id].score < 40)
    .map((seat) => ({
      seat: seat.id,
      score: reputation.seats[seat.id].score,
      trust: trustFor(reputation.seats[seat.id].score),
    }));
}
