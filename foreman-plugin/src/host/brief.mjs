/**
 * 一页简报：写进 .foreman/brief.md，并作为 system prompt 的一段注入。
 * 新窗口打开时光是这一页就够模型知道"现在到哪了"，不用翻对话。
 */
import { writeText } from './store.mjs';

const STAGE_LABEL = {
  idle: '待开工',
  meeting: '会议',
  implement: '实现',
  review: '审查',
  build: '构建',
  verify: '验收',
  accept: '已验收',
  return: '已退回',
};

export function stageLabel(stage) {
  return STAGE_LABEL[stage] || stage || '待开工';
}

export function renderBrief({ goal, state, card, evidence, challenges, archive, reputation, sharedLessons, bindingWarning, findings, decisions }) {
  const lines = [];
  lines.push(`# 监工台 · ${goal || '未命名项目'}`);
  lines.push('');
  lines.push(`- 阶段：${stageLabel(state.stage)} ｜ 当前任务卡：${card ? card.id : '无'}${card && card.frozen ? '（已冻结）' : ''}`);
  if (card) {
    const done = (card.scope && card.scope.do) || [];
    const not = (card.scope && card.scope.not) || [];
    lines.push(`- 范围：do = ${done.join(' / ') || '—'}`);
    lines.push(`- 不做：${not.join(' / ') || '—'}`);
    if ((card.acceptance || []).length) {
      lines.push(`- 验收：${card.acceptance.map((item, index) => `${index + 1}) ${item}`).join('；')}`);
    }
    if ((card.gates || []).length) {
      const entries = evidence.filter((entry) => entry.cardId === card.id);
      const gateEntries = entries.filter((entry) => entry.source === 'gate');
      const reportedEntries = entries.filter((entry) => entry.source !== 'gate');
      const parts = card.gates.map((gate) => {
        const hit = [...gateEntries].reverse().find((entry) => entry.gate === gate);
        if (!hit) return `${gate} 未跑`;
        if (hit.tampered) return `${gate} tampered`;
        return `${gate} exit ${hit.exitCode}`;
      });
      lines.push(`- 门禁：${parts.join(' ｜ ')}（gate 证据 ${gateEntries.length} 条 / reported ${reportedEntries.length} 条）`);
    }
    const cardChallenges = (challenges || []).filter((item) => item.cardId === card.id);
    const openChallenges = cardChallenges.filter((item) => item.status === 'open');
    if (openChallenges.length) {
      lines.push(`- 挑战：open ${openChallenges.length}（${openChallenges.map((item) => `${item.id} by ${item.openedBy || 'unknown'}`).join(' / ')}）`);
    } else {
      const latest = cardChallenges[cardChallenges.length - 1];
      lines.push(`- 挑战：无 open${latest ? `（最近 ${latest.id} ${latest.status}）` : ''}`);
    }
    const archives = (archive || []).filter((item) => item.cardId === card.id);
    const openArchives = archives.filter((item) => item.status === 'open');
    const sharedTop = [...(sharedLessons || [])]
      .sort((left, right) => (
        ((right.seenIn || []).length - (left.seenIn || []).length)
        || ((right.lastSeen || 0) - (left.lastSeen || 0))
      ))
      .slice(0, 3);
    const projectPart = openArchives.length
      ? `（[项目] ${openArchives.map((item) => item.id + ':' + item.fingerprint).join(' / ')}）`
      : '';
    const sharedPart = sharedTop.length
      ? ` ｜ 公共 top ${sharedTop.length}：${sharedTop.map((item) => `[公共] ${item.id}:${item.pattern || item.fingerprint}`).join(' / ')}`
      : '';
    lines.push(`- 归档：open ${openArchives.length}${projectPart}${sharedPart}`);
    const traps = [...archives]
      .sort((left, right) => (right.lastSeen || 0) - (left.lastSeen || 0))
      .slice(0, 3);
    if (traps.length) {
      lines.push(`- 历史陷阱（最多 3）：${traps.map((item) => `[项目] ${item.id} ${item.fingerprint}（${item.status}${item.regressionGuard ? '，guard' : ''}）`).join('；')}`);
    }
    if (sharedTop.length) {
      lines.push(`- 公共经验（最多 3）：${sharedTop.map((item) => `[公共] ${item.id} ${item.pattern || item.fingerprint}（${(item.seenIn || []).length} 个项目）`).join('；')}`);
    }
  }
  lines.push(`- P0（${findings.p0.length}）：${findings.p0.length ? findings.p0.map((item) => item.text).join('；') : '无'}`);
  if (findings.p1.length) lines.push(`- P1（${findings.p1.length}）：${findings.p1.map((item) => item.text).join('；')}`);
  if (state.lastVerdict && card && state.lastVerdict.cardId === card.id && state.lastVerdict.at >= card.createdAt) {
    lines.push(`- 最近裁决：${state.lastVerdict.verdict} · ${state.lastVerdict.summary || ''}`.trim());
  }
  const seats = Object.entries(state.seats || {})
    .map(([id, value]) => `${id}:${value.status}${value.agentId ? '@' + value.agentId : ''}`)
    .join(' · ');
  if (seats) lines.push(`- 五席：${seats}`);
  if (bindingWarning) lines.push(`- 绑定：${bindingWarning}`);
  else lines.push('- 绑定：当前会话已绑定五席');
  const reputationLine = Object.entries(reputation || {}).map(([id, value]) => {
    const last = value.events && value.events[value.events.length - 1];
    return `${id} ${value.score} ${value.trust}${last ? `（最近 ${last.type} ${last.delta >= 0 ? '+' : ''}${last.delta} ${last.reason}）` : ''}`;
  }).join('；');
  if (reputationLine) lines.push(`- 信誉：${reputationLine}`);
  if (decisions) {
    lines.push('');
    lines.push('## 最近结论');
    lines.push(decisions);
  }
  lines.push('');
  lines.push('规则：无契约不开工；P0 未清零不得 ACCEPT；改范围必须主持签字；每条结论追加到 `.foreman/decisions.md`。');
  return lines.join('\n');
}

export async function writeBrief(path, text) {
  await writeText(path, `${text}\n`);
}
