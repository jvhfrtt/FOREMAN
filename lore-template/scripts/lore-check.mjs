#!/usr/bin/env node
/**
 * LORE-0/LORE-1/LORE-16：世界观设定一致性门禁（真实执行，无第三方依赖）。
 *
 * 七类检查（全部输出 stderr，存在错误时 exit 1）：
 *   ① 人物/组织/地名/小神/聚落/碎片条目标题全库唯一（每个文件首个 `# ` 标题即词条标题）；
 *   ② 时间线条目（行首 `纪元-年-月 事件`，可带 `- ` 列表前缀；年/月可为「末」表示纪元之末）
 *      按（纪元,年,月）单调不倒退，纪元不同时按字典序，同年月允许并列多条；
 *   ③ 伏笔 [Fx] 与回收 [Rx] 配对：每个 F 必须有同号 R、每个 R 必须有同号 F，
 *      且同一文件内 R 出现之后不得再引用同号 F（跨文件只做配对，不做顺序）；
 *      未回收的 F 必须登记进 docs/伏笔账本.md，
 *      （无账本文件时回退为「没有对应回收」报错），已回收的 F 不受账本限制；
 *   ④ 文内 `@引用:词条名` 指向的条目标题必须存在（全库任意文件的首个标题）；
 *   ⑤ 人物/组织/地名/小神/聚落/碎片词条名必须已在 docs/术语表.md 登记；
 *   ⑥ 小神档案（`# 小神：<名>`）必须含「神域：X」行，X 为单一具体名词：
 *      一个词（不含空白）、不得命中抽象大词黑名单（战争/智慧/命运/死亡/爱），
 *      缺失或为空同样报错；
 *   ⑦ 防复读：同一文件内长段落近似重复——段落去空白并去掉常见标点后，
 *      长度 ≥60 字符且两段 bigram Jaccard 相似度 ≥0.90 视为疑似复读报错；
 *      标题行（# 开头）与代码围栏不参与，同一段不与自身比，只比同文件内段落。
 *
 * 代码围栏（```）内的行不参与任何检查。
 * 用法：node scripts/lore-check.mjs [目录]   （默认 docs）
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CATEGORY_PREFIXES = ['人物', '组织', '地名', '小神', '聚落', '碎片'];
const TITLE_RE = /^#\s+(.+)$/;
const TIMELINE_RE = /^(?:\s*[-*]\s+)?([^\s\-:]+?)-(\d+|末)-(\d+|末)\s+/;
const REF_RE = /@引用[:：]\s*([^\s)\]）】。，,;；]+)/g;
const MARKER_RE = /\[([FR])(\d+)\]/g;
/** LORE-1：小神神域的抽象大词黑名单。 */
const DOMAIN_BLACKLIST = ['战争', '智慧', '命运', '死亡', '爱'];
const DOMAIN_RE = /^神域[:：]\s*(.*)$/;

/**
 * LORE-16 ⑦ 防复读阈值：
 * - MIN_PARA_LEN：段落去空白去标点后的最小长度，低于它不参与比较（短句不误伤）；
 * - SIM_THRESHOLD：bigram Jaccard 相似度阈值。
 * 保守取值，只拦真复读：短句、对话、叠词、排比均不会误伤。
 */
const MIN_PARA_LEN = 60;
const SIM_THRESHOLD = 0.90;
/** 段落归一化时再去掉的常见标点（先去空白再去标点，仅用于相似度比较）。 */
const PARA_PUNCT_RE = /[。，、！？；：""''（）【】「」『』《》〈〉—…·,\.!?;:()\[\]{}"'`~_\-*#@\/\\|&%$^+=<>～]/g;

/** 段落归一化：去空白、去常见标点，返回用于比较的紧凑文本。 */
function normalizePara(text) {
  return text.replace(/\s+/g, '').replace(PARA_PUNCT_RE, '').trim();
}

/** 相邻字符对（bigram）集合。 */
function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

/** bigram Jaccard 相似度（0~1；空集视为 0 相似）。 */
function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  return inter / (a.size + b.size - inter);
}

async function collectMdFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

/** 解析术语表的词条列（跳过表头与分隔行）。 */
function parseGlossary(lines) {
  const names = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((cell) => cell.trim());
    const name = cells[1] || '';
    if (!name || name === '词条' || /^-+$/.test(name)) continue;
    names.add(name);
  }
  return names;
}

/**
 * 运行五类检查。返回 { files, errors }，errors 为字符串数组（每条含 文件:行: 消息）。
 */
export async function runLoreCheck(dir = 'docs') {
  const errors = [];
  const dirArg = String(dir);
  const root = resolve(dirArg);
  // @引用 报错路径相对项目根完整显示（默认补 docs/ 前缀；绝对路径取目录名兜底）。
  const displayPrefix = isAbsolute(dirArg)
    ? basename(root).replace(/\\/g, '/')
    : dirArg.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  const files = await collectMdFiles(root);
  const docs = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    docs.push({
      file: relative(root, file).replace(/\\/g, '/'),
      lines: content.split(/\r?\n/),
    });
  }

  // ---- 词条标题（每个文件首个 # 标题，围栏内不算） ----
  const titles = new Map(); // name -> { file, line, category }
  for (const doc of docs) {
    let inFence = false;
    for (let i = 0; i < doc.lines.length; i += 1) {
      const line = doc.lines[i];
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const match = line.match(TITLE_RE);
      if (!match) continue;
      const full = match[1].trim();
      let category = null;
      let name = full;
      for (const prefix of CATEGORY_PREFIXES) {
        if (full.startsWith(prefix + '：') || full.startsWith(prefix + ':')) {
          category = prefix;
          name = full.slice(prefix.length + 1).trim();
          break;
        }
      }
      if (!name) break;
      if (titles.has(name)) {
        const first = titles.get(name);
        // ①：三类词条标题全库唯一；非三类同名条目也提示（引用会歧义）。
        if (category || first.category) {
          errors.push(
            `${doc.file}:${i + 1}: 词条标题「${name}」重复（先定义于 ${first.file}:${first.line}）`,
          );
        }
        break;
      }
      titles.set(name, { file: doc.file, line: i + 1, category });
      break; // 只取文件首个标题
    }
  }

  // ---- 术语表（⑤） ----
  const glossaryDoc = docs.find((doc) => doc.file === '术语表.md' || doc.file.endsWith('/术语表.md'));
  const glossary = glossaryDoc ? parseGlossary(glossaryDoc.lines) : new Set();
  if (!glossaryDoc) {
    errors.push('docs/术语表.md 不存在：专有名词登记表缺失。');
  }
  for (const [name, entry] of titles) {
    if (entry.category && !glossary.has(name)) {
      errors.push(`${entry.file}:${entry.line}: ${entry.category}词条「${name}」未在术语表登记。`);
    }
  }

  // ---- 逐行扫描：时间线 / 引用 / 伏笔回收 / ⑦ 段落聚合 ----
  const timeline = []; // { epoch, year, month, file, line }
  const markers = [];  // { kind, id, file, line }
  for (const doc of docs) {
    let inFence = false;
    const paragraphs = [];
    let paraBuf = [];
    let paraStart = 0;
    const flushPara = () => {
      if (paraBuf.length) {
        paragraphs.push({ norm: normalizePara(paraBuf.join('')), line: paraStart });
        paraBuf = [];
        paraStart = 0;
      }
    };
    for (let i = 0; i < doc.lines.length; i += 1) {
      const line = doc.lines[i];
      if (line.trim().startsWith('```')) {
        flushPara();
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      // 行内代码段（`...`）不参与匹配（示例文案常放反引号内）。
      const shielded = line.replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length));

      // ⑦ 段落聚合：空行与标题行（# 开头）作为段落边界；标题行自身不参与比较。
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        flushPara();
      } else {
        if (!paraBuf.length) paraStart = i + 1;
        paraBuf.push(shielded);
      }

      const timelineMatch = shielded.match(TIMELINE_RE);
      if (timelineMatch) {
        timeline.push({
          epoch: timelineMatch[1],
          year: timelineMatch[2],
          month: timelineMatch[3],
          yearKey: timelineMatch[2] === '末' ? Number.MAX_SAFE_INTEGER : Number(timelineMatch[2]),
          monthKey: timelineMatch[3] === '末' ? Number.MAX_SAFE_INTEGER : Number(timelineMatch[3]),
          file: doc.file,
          line: i + 1,
        });
      }

      REF_RE.lastIndex = 0;
      let refMatch;
      while ((refMatch = REF_RE.exec(shielded)) !== null) {
        const target = refMatch[1].trim();
        if (!titles.has(target)) {
          errors.push(
            `${displayPrefix && displayPrefix !== '.' ? `${displayPrefix}/` : ''}${doc.file}:${i + 1}: `
            + `@引用:${target} 指向的条目不存在（目标须为文件首标题，术语表登记不算）。`,
          );
        }
      }

      MARKER_RE.lastIndex = 0;
      let markerMatch;
      while ((markerMatch = MARKER_RE.exec(shielded)) !== null) {
        markers.push({
          kind: markerMatch[1],
          id: Number(markerMatch[2]),
          file: doc.file,
          line: i + 1,
        });
      }
    }
    flushPara();
    doc.paragraphs = paragraphs;
  }

  // ---- ② 时间线单调 ----
  for (let index = 1; index < timeline.length; index += 1) {
    const prev = timeline[index - 1];
    const cur = timeline[index];
    const backwards = cur.epoch < prev.epoch
      || (cur.epoch === prev.epoch && (cur.yearKey < prev.yearKey
        || (cur.yearKey === prev.yearKey && cur.monthKey < prev.monthKey)));
    if (backwards) {
      errors.push(
        `${cur.file}:${cur.line}: 时间线倒退：${prev.epoch}-${prev.year}-${prev.month} 之后出现 ${cur.epoch}-${cur.year}-${cur.month}（位于 ${prev.file}:${prev.line}）。`,
      );
    }
  }

  // ---- ③ 伏笔/回收配对与顺序 ----
  // 顺序检查（R 出现后不得再引用同号 F）限定在同一文件内：文件的叙事顺序可靠，
  // 跨文件没有全局叙事顺序（文件名字典序不等于叙事先后），只做配对检查。
  const seenIds = new Set();
  const byFile = new Map();
  for (const marker of markers) {
    seenIds.add(marker.id);
    if (!byFile.has(marker.file)) byFile.set(marker.file, []);
    byFile.get(marker.file).push(marker);
  }
  for (const list of byFile.values()) {
    const reclaimed = new Set();
    for (const marker of list) {
      if (marker.kind === 'F') {
        if (reclaimed.has(marker.id)) {
          errors.push(`${marker.file}:${marker.line}: [F${marker.id}] 已回收（[R${marker.id}] 已出现），不得再引用。`);
        }
      } else {
        reclaimed.add(marker.id);
      }
    }
  }
  for (const id of [...seenIds].sort((a, b) => a - b)) {
    const hasF = markers.some((m) => m.id === id && m.kind === 'F');
    const hasR = markers.some((m) => m.id === id && m.kind === 'R');
    if (hasF && !hasR) {
      // LORE-7：未回收伏笔必须在伏笔账本登记；无账本文件时回退为「没有对应回收」。
      const ledger = docs.find((doc) => doc.file === '伏笔账本.md' || doc.file.endsWith('/伏笔账本.md'));
      if (ledger) {
        const registered = new Set();
        let inFence = false;
        for (const line of ledger.lines) {
          if (line.trim().startsWith('```')) {
            inFence = !inFence;
            continue;
          }
          if (inFence) continue;
          MARKER_RE.lastIndex = 0;
          let ledgerMatch;
          while ((ledgerMatch = MARKER_RE.exec(line)) !== null) {
            if (ledgerMatch[1] === 'F') registered.add(Number(ledgerMatch[2]));
          }
        }
        if (!registered.has(id)) {
          const first = markers.find((m) => m.id === id && m.kind === 'F' && m.file !== ledger.file);
          const at = first ?? markers.find((m) => m.id === id && m.kind === 'F');
          errors.push(`${at.file}:${at.line}: 伏笔 [F${id}] 未回收，且未登记进伏笔账本。`);
        }
      } else {
        const first = markers.find((m) => m.id === id && m.kind === 'F');
        errors.push(`${first.file}:${first.line}: 伏笔 [F${id}] 没有对应回收 [R${id}]。`);
      }
    }
    if (hasR && !hasF) {
      const first = markers.find((m) => m.id === id && m.kind === 'R');
      errors.push(`${first.file}:${first.line}: 回收 [R${id}] 没有对应伏笔 [F${id}]。`);
    }
  }

  // ---- ⑦ 防复读：同文件内长段落近似重复（bigram Jaccard，只比同文件） ----
  for (const doc of docs) {
    const paragraphs = doc.paragraphs || [];
    for (let a = 0; a < paragraphs.length; a += 1) {
      const first = paragraphs[a];
      if (first.norm.length < MIN_PARA_LEN) continue;
      const firstGrams = bigrams(first.norm);
      for (let b = a + 1; b < paragraphs.length; b += 1) {
        const second = paragraphs[b];
        if (second.norm.length < MIN_PARA_LEN) continue;
        const sim = jaccardSimilarity(firstGrams, bigrams(second.norm));
        if (sim >= SIM_THRESHOLD) {
          errors.push(
            `${doc.file}:${first.line}: 疑似复读：段落 ${first.line} 与段落 ${second.line} 高度相似（相似度 ${sim.toFixed(2)}）`,
          );
        }
      }
    }
  }

  // ---- ⑥ 小神档案「神域：X」单一具体名词 ----
  for (const [name, entry] of titles) {
    if (entry.category !== '小神') continue;
    const doc = docs.find((item) => item.file === entry.file);
    const domainLines = [];
    if (doc) {
      let inFence = false;
      for (let i = 0; i < doc.lines.length; i += 1) {
        const line = doc.lines[i];
        if (line.trim().startsWith('```')) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const shielded = line.replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length));
        const match = shielded.match(DOMAIN_RE);
        if (match) domainLines.push({ value: match[1].trim(), line: i + 1 });
      }
    }
    if (domainLines.length === 0) {
      errors.push(`${entry.file}:${entry.line}: 小神「${name}」缺少神域行（格式：神域：单一具体名词）。`);
      continue;
    }
    for (const domain of domainLines) {
      if (!domain.value) {
        errors.push(`${entry.file}:${domain.line}: 小神「${name}」神域为空，必须填写单一具体名词。`);
        continue;
      }
      if (/\s/.test(domain.value)) {
        errors.push(`${entry.file}:${domain.line}: 小神「${name}」神域「${domain.value}」不是单一具体名词（含空白，须为一个词）。`);
        continue;
      }
      const hit = DOMAIN_BLACKLIST.find((word) => domain.value.includes(word));
      if (hit) {
        errors.push(`${entry.file}:${domain.line}: 小神「${name}」神域「${domain.value}」命中抽象大词黑名单（${hit}），须用窄域具体名词。`);
      }
    }
  }

  return { files: docs.length, errors };
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  const dir = process.argv[2] || 'docs';
  const result = await runLoreCheck(dir);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    console.error(`lore-check: ${result.files} 个文件，${result.errors.length} 个错误。`);
    process.exit(1);
  }
  console.log(`lore-check: ${result.files} 个文件，0 个错误。`);
}
