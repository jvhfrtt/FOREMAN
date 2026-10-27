/* 由 src/build.mjs 生成：请改 src/client/ 下的模块，不要直接编辑本文件。 */
window.__ModuleLoader__.load({
  id: '@local/foreman',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ── src/client/ui.mjs ─────────────────────────────────
/**
 * 监工台面板：只读看板。数据来自 Host 半边的 GET /foreman/api/snapshot。
 * 样式只用 --dsw-alias-* token；所有可见文案走 Client locale（ctx.locale.bind）。
 * React / h 由 src/build.mjs 生成的 factory 外壳提供。
 */

const NS = 'foreman';

const DICT = {
  zh: {
    panel: '监工台',
    subtitle: '五席 · 契约 · 证据 · 门禁 · 裁决 · 归档 · 信誉',
    seats: '五席',
    pipeline: '流水线',
    contract: '契约',
    frozen: '已冻结',
    notFrozen: '未冻结',
    archive: '归档',
    reputation: '信誉',
    normal: '正常',
    breaker: '熔断',
    card: '当前任务卡',
    noCard: '还没有任务卡',
    noCardHint: '让模型调用 foreman_card 建第一张契约卡，没有契约不开工。',
    noEvidence: '暂无证据',
    evidence: '证据',
    p0: 'P0 阻断',
    p1: 'P1 待修',
    none: '无',
    decisions: '会议结论',
    noDecisions: '还没有写入结论。',
    refresh: '刷新',
    loading: '读取中…',
    notConfigured: '未配置项目目录',
    notConfiguredHint: '在 cordis.patch.yml 的 foreman 行把 config.root 设为项目绝对路径，然后重新加载插件。',
    frozen: '已冻结',
    do: '做',
    notDo: '不做',
    acceptance: '验收',
    gates: '门禁',
    missing: '未跑',
    reported: '申报值',
    gateEvidence: '插件执行',
    reportedEvidence: '申报值',
    tampered: '测试被改',
    timedOut: '超时',
    challenge: '挑战',
    openChallenges: 'open 挑战',
    sharedLessons: '公共经验',
    bindingWarning: '绑定不完整',
    rebindRequired: 'rebind-required',
    tail: '输出尾部',
    outputs: '个产物',
    stage_idle: '待开工',
    stage_meeting: '会议',
    stage_implement: '实现',
    stage_review: '审查/挑战',
    stage_build: '门禁',
    stage_verify: '验收',
    stage_accept: '已验收',
    stage_return: '已退回',
    seat_idle: '待命',
    seat_working: '进行中',
    seat_done: '已交付',
    seat_blocked: '阻塞',
  },
  en: {
    panel: 'Foreman',
    subtitle: '5 seats · contract · evidence · gates · verdict · archive · reputation',
    seats: 'Seats',
    pipeline: 'Pipeline',
    contract: 'Contract',
    frozen: 'frozen',
    notFrozen: 'unfrozen',
    archive: 'Archive',
    reputation: 'Reputation',
    normal: 'normal',
    breaker: 'breaker',
    card: 'Current card',
    noCard: 'No task card yet',
    noCardHint: 'Ask the agent to call foreman_card to create the first contract. No contract, no work.',
    noEvidence: 'No evidence yet',
    evidence: 'Evidence',
    p0: 'P0 blocking',
    p1: 'P1 open',
    none: 'none',
    decisions: 'Decisions',
    noDecisions: 'Nothing recorded yet.',
    refresh: 'Refresh',
    loading: 'Loading…',
    notConfigured: 'Project root not configured',
    notConfiguredHint: 'Set config.root to the project absolute path on the foreman row in cordis.patch.yml, then reload the plugin.',
    frozen: 'frozen',
    do: 'do',
    notDo: 'not',
    acceptance: 'Acceptance',
    gates: 'Gates',
    missing: 'not run',
    reported: 'reported',
    gateEvidence: 'plugin-run',
    reportedEvidence: 'reported',
    tampered: 'tests changed',
    timedOut: 'timeout',
    challenge: 'Challenge',
    openChallenges: 'open challenges',
    sharedLessons: 'shared lessons',
    bindingWarning: 'seat binding incomplete',
    rebindRequired: 'rebind-required',
    tail: 'Output tail',
    outputs: 'outputs',
    stage_idle: 'Idle',
    stage_meeting: 'Meeting',
    stage_implement: 'Implement',
    stage_review: 'Review / challenge',
    stage_build: 'Gates',
    stage_verify: 'Verify',
    stage_accept: 'Accepted',
    stage_return: 'Returned',
    seat_idle: 'idle',
    seat_working: 'working',
    seat_done: 'done',
    seat_blocked: 'blocked',
  },
};

const STEPS = ['meeting', 'implement', 'review', 'build', 'verify', 'accept'];
const SEAT_TONE = {
  idle: 'var(--dsw-alias-state-idle-primary)',
  working: 'var(--dsw-alias-brand-primary)',
  done: 'var(--dsw-alias-state-success-primary)',
  blocked: 'var(--dsw-alias-state-error-primary)',
};

const CSS = `
.fm-root{height:100%;min-height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow:hidden}
.fm-root *{box-sizing:border-box}
.fm-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:18px 22px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fm-title{font-size:17px;font-weight:600;letter-spacing:.02em}
.fm-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.fm-head-right{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.fm-rootpath{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.fm-btn:hover{border-color:var(--dsw-alias-border-l2)}
.fm-btn[disabled]{opacity:.55;cursor:default}
.fm-body{flex:1;min-height:0;display:grid;grid-template-columns:216px minmax(0,1fr) 300px;overflow:hidden}
.fm-col{min-height:0;overflow:auto;padding:14px 16px 44px}
.fm-col+.fm-col{border-left:1px solid var(--dsw-alias-border-l1)}
.fm-col-title{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:0 0 10px}
.fm-seat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}
.fm-seat-top{display:flex;align-items:center;gap:7px}
.fm-dot{width:7px;height:7px;border-radius:50%;flex:none}
.fm-seatname{font-weight:600;font-size:12.5px}
.fm-seatstate{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}
.fm-seatduty{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.fm-seatnote{font-size:11px;color:var(--dsw-alias-brand-primary);margin-top:3px}
.fm-seatagent{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-pipe{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.fm-checks{display:flex;gap:6px;flex-wrap:wrap;margin:-6px 0 14px}
.fm-check{font-size:10.5px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary)}
.fm-check.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.fm-check.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.fm-step{font-size:11.5px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 9px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.fm-step.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.fm-step.done{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.fm-step.bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.fm-arrow{color:var(--dsw-alias-border-l2);font-size:11px}
.fm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin-bottom:14px}
.fm-cardhead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.fm-cardid{font-size:15px;font-weight:600}
.fm-tag{font-size:10.5px;border-radius:999px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.fm-tag.frozen{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.fm-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.fm-tag.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.fm-row{display:flex;gap:8px;margin-bottom:6px}
.fm-k{flex:none;width:44px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.fm-v{min-width:0;font-size:12.5px}
.fm-list{margin:0;padding:0;list-style:none;font-size:12.5px}
.fm-list li{position:relative;padding-left:13px;margin-bottom:2px}
.fm-list li::before{content:'';position:absolute;left:2px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.fm-gates{display:flex;gap:6px;flex-wrap:wrap}
.fm-gate{font-size:11.5px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 7px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.fm-gate.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.fm-gate.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.fm-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.fm-notice{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;padding:12px 14px;font-size:12.5px}
.fm-notice b{display:block;margin-bottom:4px}
.fm-ev{border-bottom:1px solid var(--dsw-alias-border-l1);padding:7px 0}
.fm-ev:last-child{border-bottom:none}
.fm-ev-top{display:flex;align-items:center;gap:8px;font-size:12.5px}
.fm-ev-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-ev pre{margin:6px 0 0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.5;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.fm-ev summary{cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.fm-find{border-left:3px solid var(--dsw-alias-border-l2);padding:4px 0 4px 9px;margin-bottom:7px;font-size:12.5px}
.fm-find.error{border-color:var(--dsw-alias-state-error-primary)}
.fm-find.warn{border-color:var(--dsw-alias-state-warn-primary)}
.fm-dec{margin-bottom:10px;font-size:12px}
.fm-dec-h{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}
.fm-dec-b{white-space:pre-wrap;word-break:break-word}
@media (max-width:1180px){.fm-body{grid-template-columns:1fr;overflow:auto}.fm-col+.fm-col{border-left:none;border-top:1px solid var(--dsw-alias-border-l1)}}
`;

function fetchSnapshot() {
  return fetch('/foreman/api/snapshot', { headers: { accept: 'application/json' }, cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))));
}

function Pipeline({ t, snapshot }) {
  const stage = (snapshot && snapshot.state && snapshot.state.stage) || 'idle';
  const index = STEPS.indexOf(stage);
  const parts = [];
  STEPS.forEach((step, position) => {
    const done = index > position || stage === 'accept';
    const on = index === position;
    const bad = stage === 'return' && position >= STEPS.length - 2;
    if (position > 0) parts.push(h('span', { key: `${step}-arrow`, className: 'fm-arrow' }, '›'));
    parts.push(h('span', {
      key: step,
      className: `fm-step${on ? ' on' : ''}${done ? ' done' : ''}${bad ? ' bad' : ''}`,
    }, t(`stage_${step}`)));
  });
  const card = snapshot && snapshot.card;
  const evidence = (snapshot && snapshot.evidence) || [];
  const gates = (card && card.gates) || [];
  const passed = gates.filter((gate) => evidence.some((entry) => (
    entry.cardId === card.id && entry.gate === gate && entry.source === 'gate'
    && entry.exitCode === 0 && entry.tampered !== true && entry.timedOut !== true
  ))).length;
  const openChallenges = (snapshot && snapshot.openChallengeCount) || 0;
  const openArchive = (snapshot && snapshot.openArchiveCount) || 0;
  const breakers = (snapshot && snapshot.breakers) || [];
  const checks = [
    { key: 'contract', ok: Boolean(card && card.frozen), text: `${t('contract')} · ${card && card.frozen ? t('frozen') : t('notFrozen')}` },
    { key: 'gates', ok: gates.length > 0 && passed === gates.length, bad: gates.length > 0 && passed < gates.length, text: `${t('gates')} · ${passed}/${gates.length}` },
    { key: 'challenge', ok: openChallenges === 0, bad: openChallenges > 0, text: `${t('challenge')} · ${openChallenges || t('none')}` },
    { key: 'archive', ok: openArchive === 0, bad: openArchive > 0, text: `${t('archive')} · ${openArchive || t('none')}` },
    { key: 'reputation', ok: breakers.length === 0, bad: breakers.length > 0, text: `${t('reputation')} · ${breakers.length ? `${breakers.length} ${t('breaker')}` : t('normal')}` },
  ];
  return h('div', null,
    h('div', { className: 'fm-pipe' }, parts),
    h('div', { className: 'fm-checks' }, checks.map((check) => h('span', {
      key: check.key,
      className: `fm-check${check.ok ? ' ok' : ''}${check.bad ? ' bad' : ''}`,
    }, check.text))));
}

function gateLocation(entry) {
  if (!entry) return undefined;
  const parts = [];
  if (entry.root) parts.push(`root: ${entry.root}`);
  if (entry.cwd) parts.push(`cwd: ${entry.cwd}`);
  if (entry.outsideRoot) parts.push('allowOutsideRoot（root 外）');
  return parts.length ? parts.join('\n') : undefined;
}

function CardView({ t, snapshot }) {
  const card = snapshot.card;
  if (!card) {
    return h('div', { className: 'fm-empty' },
      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('noCard')),
      h('div', null, t('noCardHint')));
  }
  const evidence = snapshot.evidence || [];
  const gateState = (gate) => {
    const hit = evidence.find((entry) => (
      entry.cardId === card.id
      && entry.gate === gate
      && entry.source === 'gate'
    ));
    if (!hit) return { className: '', text: `${gate} · ${t('missing')}` };
    const passed = hit.exitCode === 0 && hit.tampered !== true && hit.timedOut !== true;
    const detail = hit.timedOut ? t('timedOut')
      : hit.tampered ? t('tampered')
        : hit.exitCode === null || hit.exitCode === undefined ? '—' : `exit ${hit.exitCode}`;
    return { className: passed ? 'ok' : 'bad', text: `${gate} · ${detail}`, title: gateLocation(hit) };
  };
  return h('div', { className: 'fm-card' },
    h('div', { className: 'fm-cardhead' },
      h('span', { className: 'fm-cardid' }, card.id),
      card.frozen ? h('span', { className: 'fm-tag frozen' }, t('frozen')) : null,
      card.status === 'accepted' ? h('span', { className: 'fm-tag ok' }, 'ACCEPT') : null,
      card.status === 'returned' ? h('span', { className: 'fm-tag bad' }, 'RETURN') : null,
      card.revise ? h('span', { className: 'fm-tag' }, `rev ${card.revise}`) : null),
    h('div', { className: 'fm-row' },
      h('span', { className: 'fm-k' }, t('do')),
      h('ul', { className: 'fm-list fm-v' }, ((card.scope && card.scope.do) || []).map((item, index) => h('li', { key: index }, item)))),
    h('div', { className: 'fm-row' },
      h('span', { className: 'fm-k' }, t('notDo')),
      h('ul', { className: 'fm-list fm-v' }, ((card.scope && card.scope.not) || []).map((item, index) => h('li', { key: index }, item)))),
    h('div', { className: 'fm-row' },
      h('span', { className: 'fm-k' }, t('acceptance')),
      h('ul', { className: 'fm-list fm-v' }, (card.acceptance || []).map((item, index) => h('li', { key: index }, item)))),
    h('div', { className: 'fm-row' },
      h('span', { className: 'fm-k' }, t('gates')),
      h('div', { className: 'fm-gates fm-v' }, (card.gates || []).map((gate) => {
        const state = gateState(gate);
        return h('span', { key: gate, className: `fm-gate${state.className ? ` ${state.className}` : ''}`, title: state.title }, state.text);
      }))));
}

function EvidenceList({ t, snapshot }) {
  const entries = snapshot.evidence || [];
  return h('div', null,
    h('div', { className: 'fm-col-title' }, `${t('evidence')} · ${snapshot.evidenceCount || entries.length}`),
    entries.length === 0
      ? h('div', { className: 'fm-empty' }, t('noEvidence'))
      : entries.map((entry) => h('div', { key: entry.id, className: 'fm-ev' },
        h('div', { className: 'fm-ev-top' },
          h('span', {
            className: `fm-gate${entry.source === 'gate'
              ? (entry.exitCode === 0 && entry.tampered !== true && entry.timedOut !== true ? ' ok' : ' bad')
              : (entry.exitCode === 0 ? '' : ' bad')}`,
            title: gateLocation(entry),
          }, entry.source === 'gate'
            ? (entry.timedOut ? `${entry.gate} · ${t('timedOut')}`
              : entry.tampered ? `${entry.gate} · ${t('tampered')}`
                : entry.exitCode === null || entry.exitCode === undefined ? entry.gate : `${entry.gate} · exit ${entry.exitCode}`)
            : entry.exitCode === null || entry.exitCode === undefined ? entry.gate : `${entry.gate} · exit ${entry.exitCode}`),
          h('span', { className: 'fm-tag' }, `${entry.id} · ${entry.source === 'gate' ? t('gateEvidence') : t('reportedEvidence')}`)),
        h('div', { className: 'fm-ev-meta' },
          `${entry.cmd || '—'}${entry.files && entry.files.length ? ` · ${entry.files.length} ${t('outputs')}` : ''}`),
        entry.tail ? h('details', null, h('summary', null, t('tail')), h('pre', null, entry.tail)) : null)));
}

function Findings({ t, title, items, tone }) {
  return h('div', { style: { marginBottom: 14 } },
    h('div', { className: 'fm-col-title' }, `${title} · ${(items || []).length}`),
    (items || []).length === 0
      ? h('div', { className: 'fm-v', style: { color: 'var(--dsw-alias-label-secondary)' } }, t('none'))
      : (items || []).map((item, index) => h('div', { key: index, className: `fm-find ${tone}` }, item.text || String(item))));
}

function Decisions({ t, text }) {
  const blocks = String(text || '')
    .split(/\n## /)
    .filter((block) => block.trim() !== '')
    .slice(-6);
  return h('div', null,
    h('div', { className: 'fm-col-title' }, t('decisions')),
    blocks.length === 0
      ? h('div', { className: 'fm-empty' }, t('noDecisions'))
      : blocks.map((block, index) => {
        const lines = block.replace(/^## /, '').split('\n');
        return h('div', { key: index, className: 'fm-dec' },
          h('div', { className: 'fm-dec-h' }, lines[0]),
          h('div', { className: 'fm-dec-b' }, lines.slice(1).join('\n').trim()));
      }));
}

function Panel(props) {
  const t = (props && typeof props.t === 'function') ? props.t : ((key) => key);
  const [snapshot, setSnapshot] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(() => {
    setBusy(true);
    return fetchSnapshot()
      .then((next) => {
        setSnapshot(next);
        setError(next && next.ok ? '' : (next && next.error) || '');
      })
      .catch((failure) => {
        setError(failure && failure.message ? failure.message : String(failure));
      })
      .then(() => setBusy(false));
  }, []);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void refresh();
    };
    tick();
    const timer = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refresh]);

  let body;
  if (!snapshot) {
    body = h('div', { className: 'fm-col', style: { gridColumn: '1 / -1' } }, h('div', { className: 'fm-empty' }, t('loading')));
  } else if (!snapshot.ok) {
    body = h('div', { className: 'fm-col', style: { gridColumn: '1 / -1' } },
      h('div', { className: 'fm-notice' },
        h('b', null, t('notConfigured')),
        h('div', null, t('notConfiguredHint')),
        h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-label-secondary)' } }, error || '')));
  } else {
    body = h('div', { className: 'fm-body' },
      h('aside', { className: 'fm-col' },
        h('div', { className: 'fm-col-title' }, t('seats')),
        (snapshot.roster || []).map((seat) => h('div', { key: seat.id, className: 'fm-seat' },
          h('div', { className: 'fm-seat-top' },
            h('span', { className: 'fm-dot', style: { background: SEAT_TONE[seat.status] || SEAT_TONE.idle } }),
            h('span', { className: 'fm-seatname' }, seat.name),
            h('span', { className: 'fm-seatstate' }, t(`seat_${seat.status}`))),
          h('div', { className: 'fm-seatduty' }, seat.duty || ''),
          seat.agentId ? h('div', { className: 'fm-seatagent', title: seat.agentId }, seat.agentId) : null,
          seat.note ? h('div', { className: 'fm-seatnote' }, seat.note) : null))),
      h('main', { className: 'fm-col' },
        h('div', { className: 'fm-col-title' }, `${t('pipeline')} · ${t(`stage_${(snapshot.state && snapshot.state.stage) || 'idle'}`)}`),
        h(Pipeline, { t, snapshot }),
        h(CardView, { t, snapshot }),
        h(EvidenceList, { t, snapshot })),
      h('aside', { className: 'fm-col' },
        h(Findings, { t, title: t('p0'), items: snapshot.findings ? snapshot.findings.p0 : [], tone: 'error' }),
        h(Findings, { t, title: t('p1'), items: snapshot.findings ? snapshot.findings.p1 : [], tone: 'warn' }),
        h(Decisions, { t, text: snapshot.decisions })));
  }

  return h('div', { className: 'fm-root' },
    h('style', null, CSS),
    h('header', { className: 'fm-head' },
      h('div', null,
        h('div', { className: 'fm-title' }, t('panel')),
        h('div', { className: 'fm-sub' },
          `${snapshot && snapshot.goal ? `${snapshot.goal} · ` : ''}${t('subtitle')}`)),
      h('div', { className: 'fm-head-right' },
        snapshot && snapshot.root ? h('span', { className: 'fm-rootpath', title: snapshot.root }, snapshot.root) : null,
        snapshot && snapshot.rebindRequired
          ? h('span', { className: 'fm-tag bad', title: snapshot.bindingWarning || t('rebindRequired') }, t('rebindRequired'))
          : snapshot && snapshot.bindingWarning
            ? h('span', { className: 'fm-tag bad', title: snapshot.bindingWarning }, t('bindingWarning'))
            : null,
        snapshot && typeof snapshot.sharedLessonCount === 'number'
          ? h('span', { className: snapshot.sharedLessonCount > 0 ? 'fm-tag ok' : 'fm-tag' }, `${t('sharedLessons')} ${snapshot.sharedLessonCount}`)
          : null,
        snapshot && snapshot.openChallengeCount
          ? h('span', { className: 'fm-tag bad' }, `${t('openChallenges')} ${snapshot.openChallengeCount}`)
          : null,
        h('button', { type: 'button', className: 'fm-btn', disabled: busy, onClick: () => void refresh() },
          busy ? t('loading') : t('refresh')))),
    body);
}

function PanelIcon(props) {
  const size = props && props.size ? props.size : 18;
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    style: { display: 'block' },
  },
  h('path', { d: 'M3.6 17.2h16.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
  h('path', { d: 'M6.2 17.2c0-4.5 2.4-7.6 5.8-7.6s5.8 3.1 5.8 7.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
  h('path', { d: 'M12 9.4V6.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
  h('circle', { cx: 12, cy: 5.2, r: 1.15, fill: 'currentColor' }),
  h('path', { d: 'M9.4 14.6l1.7 1.7 3.4-3.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
}

function createClientModule() {
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'foreman: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'foreman', inject: () => ({ t }),
      }, Panel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'foreman', order: 30, label: () => t('panel'),
      }, PanelIcon));
    },
    __components: { Panel, PanelIcon, Pipeline, CardView, EvidenceList, Findings, Decisions },
  };
}

    return createClientModule();
  },
});
