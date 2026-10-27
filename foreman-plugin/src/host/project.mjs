/**
 * M3.1 多项目 active root：仅做 root 校验和状态投影。
 * 真正的切换状态机在 Foreman.runProject；这里保持无副作用、可单测。
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export async function validateProjectRoot(rawRoot) {
  const raw = String(rawRoot || '').trim();
  if (!raw) return { ok: false, error: 'root 不能为空。' };
  if (!isAbsolute(raw)) return { ok: false, error: 'root 必须是绝对路径。' };
  const root = resolve(raw);
  let info;
  try {
    info = await stat(root);
  } catch {
    return { ok: false, error: `项目目录不存在：${root}` };
  }
  if (!info.isDirectory()) return { ok: false, error: `不是目录：${root}` };
  return { ok: true, root };
}

export function projectSummary(action, root, snapshot) {
  return {
    ok: true,
    action,
    root,
    card: snapshot && snapshot.card
      ? { id: snapshot.card.id, status: snapshot.card.status, frozen: snapshot.card.frozen }
      : null,
    stage: snapshot ? snapshot.stage : 'idle',
    openChallengeCount: snapshot ? snapshot.openChallengeCount : 0,
  };
}
