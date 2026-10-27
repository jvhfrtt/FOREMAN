/**
 * M6：跨项目 shared lessons。
 * 项目 archive 不动；这里只存人工 promote 后、脱敏的 pattern 级经验。
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readJson, writeJson } from './store.mjs';

const FIELDS = ['pattern', 'area', 'symptom', 'rootCause', 'fixPattern', 'regressionGuard'];

export function defaultSharedLessonsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'foreman', 'shared', 'lessons.json');
}

export function resolveSharedLessonsPath(configured) {
  const raw = String(configured || '').trim();
  if (!raw) return { ok: true, path: defaultSharedLessonsPath() };
  if (!isAbsolute(raw)) return { ok: false, error: 'sharedLessonsPath 必须是绝对路径。' };
  return { ok: true, path: resolve(raw) };
}

export function emptySharedLessons() {
  return { version: 1, next: 1, lessons: [] };
}

export async function readSharedLessons(file) {
  const store = await readJson(file, null).catch(() => null);
  if (!store || !Array.isArray(store.lessons)) return emptySharedLessons();
  return {
    version: store.version || 1,
    next: typeof store.next === 'number' ? store.next : store.lessons.length + 1,
    lessons: store.lessons.filter((lesson) => lesson && typeof lesson.fingerprint === 'string'),
  };
}

async function writeSharedLessons(file, store) {
  await mkdir(dirname(file), { recursive: true });
  await writeJson(file, store);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeSharedText(value, { root, cardId, projectName } = {}) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (root) {
    text = text.replace(new RegExp(escapeRegExp(String(root)), 'gi'), '[path]');
  }
  // M7.12：只替换真实路径（盘符 / UNC / 绝对 POSIX 路径 / 顶层项目 root），
  // 不把 `pattern/area/symptom/...` 这类字段名斜杠列表当路径。
  // POSIX 绝对路径必须从行首/空白/开引号等边界开始，避免命中 xxx/area/symptom。
  text = text
    .replace(/\b[A-Za-z]:[\\/][^\s，。；;)"'<>]*/g, '[path]')
    .replace(/\\\\[^\s，。；;)"'<>]+/g, '[path]')
    .replace(/(^|[\s("'`=:：，。；;\[{])((?:\/[\w.-]+){2,})/g, '$1[path]');
  if (projectName) {
    text = text.replace(new RegExp(escapeRegExp(String(projectName)), 'gi'), '[project]');
  }
  if (cardId) {
    text = text.replace(new RegExp(escapeRegExp(String(cardId)), 'gi'), '[card]');
  }
  // M7.7：只把真实卡号样式（A4 / M2-03 / M7.6）脱敏；P0/P1/P2 是 finding 级别，不能当卡号替换掉。
  text = text
    .replace(/\b(?!P[0-2]\b)[A-Z]{1,4}\d+(?:\.\d+)?(?:-\d+)?\b/g, '[card]')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

export function projectKey(root) {
  return createHash('sha256').update(String(root)).digest('hex').slice(0, 12);
}

function addUnique(list, value) {
  if (!Array.isArray(list)) return [value];
  return list.includes(value) ? list : [...list, value];
}

export async function promoteSharedLesson(file, { archive, archiveId, root, fingerprint }) {
  const entries = archive && Array.isArray(archive.entries) ? archive.entries : [];
  const source = archiveId
    ? entries.find((entry) => entry.id === archiveId)
    : entries.find((entry) => entry.cardId === (archive && archive.cardId) && entry.fingerprint === fingerprint);
  if (!source) return { ok: false, error: '项目归档条目不存在。' };
  const project = projectKey(root);
  const pattern = sanitizeSharedText(source.fingerprint, {
    root,
    cardId: source.cardId,
    projectName: basename(root),
  }) || '[pattern]';
  const fields = {
    pattern,
    area: sanitizeSharedText(source.area, { root, cardId: source.cardId, projectName: basename(root) }),
    symptom: sanitizeSharedText(source.symptom, { root, cardId: source.cardId, projectName: basename(root) }),
    rootCause: sanitizeSharedText(source.rootCause, { root, cardId: source.cardId, projectName: basename(root) }),
    fixPattern: sanitizeSharedText(source.fix, { root, cardId: source.cardId, projectName: basename(root) }),
    regressionGuard: sanitizeSharedText(source.regressionGuard, { root, cardId: source.cardId, projectName: basename(root) }),
  };
  const store = await readSharedLessons(file);
  const existing = store.lessons.find((lesson) => lesson.fingerprint === pattern);
  if (existing) {
    existing.seenIn = addUnique(existing.seenIn, project);
    existing.projects = addUnique(existing.projects, project);
    existing.lastSeen = Date.now();
    for (const field of FIELDS) {
      if (!existing[field] && fields[field]) existing[field] = fields[field];
    }
    await writeSharedLessons(file, store);
    return { ok: true, existing: true, lesson: existing, sourceId: source.id };
  }
  const lesson = {
    id: `S${store.next || 1}`,
    fingerprint: pattern,
    seenIn: [project],
    projects: [project],
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ...fields,
  };
  store.next = (store.next || 1) + 1;
  store.lessons = [...store.lessons, lesson];
  await writeSharedLessons(file, store);
  return { ok: true, existing: false, lesson, sourceId: source.id };
}

export async function demoteSharedLesson(file, { id, fingerprint }) {
  const store = await readSharedLessons(file);
  const index = store.lessons.findIndex((lesson) => (
    (id && lesson.id === id) || (fingerprint && lesson.fingerprint === fingerprint)
  ));
  if (index < 0) return { ok: false, error: '公共经验条目不存在。' };
  const [lesson] = store.lessons.splice(index, 1);
  await writeSharedLessons(file, store);
  return { ok: true, lesson };
}

export async function listSharedLessons(file) {
  const store = await readSharedLessons(file);
  const lessons = [...store.lessons].sort((left, right) => (
    ((right.seenIn || []).length - (left.seenIn || []).length)
    || ((right.lastSeen || 0) - (left.lastSeen || 0))
  ));
  return lessons;
}
