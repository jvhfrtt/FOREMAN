/**
 * 离线冒烟 M2：假 ctx.subprocess，不启动真实 vitest / Harness。
 *   node test/smoke.mjs
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Foreman } from '../src/host/foreman.mjs';
import { renderBrief } from '../src/host/brief.mjs';
import { defaultSharedLessonsPath, resolveSharedLessonsPath, sanitizeSharedText } from '../src/host/shared-lessons.mjs';
import { collectArtifacts, gateCwdIssue, gateSpecHash, isPathInsideRoot, normalizeGateRegistry } from '../src/host/gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(join(tmpdir(), `foreman-m2-smoke-${process.pid}-${Date.now()}`));
const rootB = resolve(join(tmpdir(), `foreman-m2-smoke-b-${process.pid}-${Date.now()}`));
const outsideDir = resolve(join(tmpdir(), `foreman-m2-smoke-outside-${process.pid}-${Date.now()}`));
const sharedFile = join(tmpdir(), `foreman-shared-${process.pid}-${Date.now()}`, 'lessons.json');
await rm(root, { recursive: true, force: true });
await rm(rootB, { recursive: true, force: true });
await rm(outsideDir, { recursive: true, force: true });
await rm(dirname(sharedFile), { recursive: true, force: true });
await mkdir(join(root, 'test'), { recursive: true });
await mkdir(join(rootB, 'test'), { recursive: true });
await mkdir(join(outsideDir, 'test'), { recursive: true });
await writeFile(join(root, 'PROGRESS.md'), '# 冒烟产物\n', 'utf8');
await writeFile(join(rootB, 'PROGRESS.md'), '# 冒烟项目 B\n', 'utf8');
await writeFile(join(rootB, 'test', 'sample.test.mjs'), '// B test\n', 'utf8');
await writeFile(join(outsideDir, 'PROGRESS.md'), '# 插件侧 gate 目录\n', 'utf8');
await writeFile(join(outsideDir, 'test', 'sample.test.mjs'), '// outside test\n', 'utf8');
const testFile = join(root, 'test', 'sample.test.mjs');
const testContent = '// original test\n';
await writeFile(testFile, testContent, 'utf8');

let scenario = { exitCode: 0, stdout: 'fake stdout', stderr: '', tamper: false, hang: false };
const spawnLog = [];
const fakeSubprocess = {
  spawn(spec) {
    spawnLog.push(spec);
    const current = { ...scenario };
    if (current.tamper) writeFileSync(testFile, `${testContent}// mutated ${Date.now()}\n`, 'utf8');
    let settle;
    let finished = false;
    const done = new Promise((resolve) => { settle = resolve; });
    const finish = (exitCode, signal = null) => {
      if (finished) return;
      finished = true;
      settle({ exitCode, signal });
    };
    if (!current.hang) setTimeout(() => finish(current.exitCode), 5);
    const reader = (text) => ({
      readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }),
    });
    return {
      stdin: null,
      stdout: null,
      stderr: null,
      control: null,
      collected: { stdout: reader(current.stdout), stderr: reader(current.stderr) },
      done,
      terminate: () => finish(null, 'SIGTERM'),
      waitForExit: async () => true,
    };
  },
};

const seen = {
  tools: [],
  guard: null,
  command: null,
  route: null,
  section: null,
  agentCreated: null,
  agentDisposed: null,
  toolsChange: null,
  lateTools: [],
  filters: [],
  scopedTools: [],
  agents: [],
};
const ctx = {
  subprocess: fakeSubprocess,
  tools: {
    register: (definition) => { seen.tools.push(definition); return () => {}; },
    guard: (callback) => { seen.guard = callback; return () => {}; },
  },
  agents: {
    list: () => seen.agents,
    get: (id) => seen.agents.find((agent) => agent.id === id),
  },
  on: (event, listener) => {
    if (event === 'agent/created') seen.agentCreated = listener;
    if (event === 'agent/disposed') seen.agentDisposed = listener;
    if (event === 'tools/change') seen.toolsChange = listener;
    return () => {};
  },
  commands: { register: (definition) => { seen.command = definition; return () => {}; } },
  webServer: { register: (route) => { seen.route = route; return () => {}; } },
  systemPrompt: { section: (section) => { seen.section = section; return () => {}; } },
  effect: (callback) => callback(),
};

const fakeAgent = (id, options = {}) => {
  let activeFilter = null;
  const baseSchemas = () => [
    ...seen.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    ...['read', 'grep', 'glob', 'read_image', 'write', 'edit', 'str_replace_editor', 'pwsh', 'bash', 'terminal', 'job_output', 'job_kill', 'create_goal']
      .map((name) => ({ name, description: name, parameters: {} })),
    ...seen.lateTools.map((name) => ({ name, description: name, parameters: {} })),
  ];
  return {
    id,
    ctx: {
      effect: (callback) => callback(),
      tools: {
        schemas: () => {
          if (typeof options.schemas === 'function') return options.schemas(baseSchemas(), activeFilter);
          const all = baseSchemas();
          if (!activeFilter) return all;
          if (Array.isArray(activeFilter.allow)) return all.filter((tool) => activeFilter.allow.includes(tool.name));
          if (Array.isArray(activeFilter.deny)) return all.filter((tool) => !activeFilter.deny.includes(tool.name));
          return all;
        },
        restrict: (filter) => {
          // live-like 模式：DSH tools.restrict() 对未知全局工具名会整条抛错，
          // 用它复现“str_replace_editor 未注册导致 builder filter 装不上”的 live 问题。
          if (Array.isArray(options.knownTools)) {
            const known = new Set(options.knownTools);
            const unknown = [...(filter.allow || []), ...(filter.deny || [])]
              .filter((name) => !known.has(name));
            if (unknown.length) {
              throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((name) => `"${name}"`).join(', ')}; known global tools: ${[...known].join(', ')}`);
            }
          }
          seen.filters.push({ agentId: id, filter });
          activeFilter = filter;
          return () => { if (activeFilter === filter) activeFilter = null; };
        },
        register: (definition) => {
          seen.scopedTools.push({ agentId: id, definition });
          return () => {};
        },
      },
    },
  };
};

const gateConfig = {
  'gate-smoke': { cwd: root, argv: ['node', 'test/smoke.mjs'], testsRoot: 'test', timeoutMs: 500 },
  'gate-syntax': { cwd: root, argv: ['node', '--check', 'index.js'], testsRoot: 'test', timeoutMs: 500 },
  'gate-cross': { cwd: root, argv: ['node', '-e', 'cross'], testsRoot: 'test', timeoutMs: 500 },
  'gate-no-tests': { cwd: root, argv: ['node', '-e', 'missing'], testsRoot: 'missing-tests', timeoutMs: 500 },
  'gate-relative': { cwd: '.', argv: ['node', '-e', 'relative'], testsRoot: 'test', timeoutMs: 500 },
  'gate-outside-default': { cwd: outsideDir, argv: ['node', '-e', 'outside-default'], testsRoot: 'test', timeoutMs: 500 },
  'gate-outside-allow': {
    cwd: outsideDir,
    allowOutsideRoot: true,
    argv: ['node', '-e', 'outside-allow'],
    testsRoot: 'test',
    timeoutMs: 500,
  },
  'gate-artifacts': {
    cwd: root,
    argv: ['node', '-e', 'artifacts'],
    testsRoot: 'test',
    timeoutMs: 500,
    artifacts: ['dist/**', 'nope/**', 'missing-dir/**'],
  },
};
const reviewerId = 'reviewer-agent-smoke';
const nitpickerId = 'nitpicker-agent-smoke';
const archivistId = 'archivist-agent-smoke';
const hostId = 'host-agent-smoke';
const rosterConfig = [
  { id: 'coder', agentId: 'coder-agent-smoke' },
  { id: 'reviewer', agentId: reviewerId },
  { id: 'builder', agentId: 'builder-agent-smoke' },
  { id: 'nitpicker', agentId: nitpickerId },
  { id: 'archivist', agentId: archivistId },
];
const foreman = new Foreman(ctx, { root, goal: '冒烟项目', gates: gateConfig, roster: rosterConfig, gateGraceMs: 20, sharedLessonsPath: sharedFile });
foreman.register();
await foreman.ensureReady();

const tool = (name) => seen.tools.find((item) => item.name === name);
let failed = 0;
const assert = (condition, message) => {
  if (!condition) {
    failed += 1;
    console.error(`BAD  ${message}`);
    return;
  }
  console.log(`ok   ${message}`);
};

// M7.3：gate cwd 与 active root 的绑定（纯函数先行）
const normalized = normalizeGateRegistry(root, gateConfig);
assert(normalized['gate-relative'].cwd === root, '相对 cwd 按 active root 解析');
assert(normalized['gate-relative'].cwdSpec === '.', '相对 cwd 保留原始 spec');
assert(normalized['gate-outside-allow'].outsideRoot === true && normalized['gate-outside-allow'].allowOutsideRoot === true, 'root 外 cwd 标记 outsideRoot/allowOutsideRoot');
assert(Boolean(gateCwdIssue(normalized['gate-outside-default'], root)), '绝对 cwd 越界默认拒绝');
const defaultOutsideIssue = gateCwdIssue(normalized['gate-outside-default'], root) || {};
assert(
  defaultOutsideIssue.cwd === outsideDir
  && defaultOutsideIssue.root === root
  && /allowOutsideRoot/.test(defaultOutsideIssue.error),
  '越界拒绝信息带 cwd/root/allowOutsideRoot 提示',
);
assert(gateCwdIssue(normalized['gate-outside-allow'], root) === null, '显式 allowOutsideRoot 的 gate 不被拒');
assert(gateCwdIssue(normalized['gate-relative'], root) === null, 'root 内相对 cwd 通过');
assert(gateCwdIssue(normalized['gate-smoke'], root) === null, 'root 内绝对 cwd 通过');
assert(isPathInsideRoot(root, root) && isPathInsideRoot(root, join(root, 'test')), 'isPathInsideRoot 接受 root 及子目录');
assert(!isPathInsideRoot(root, outsideDir), 'isPathInsideRoot 拒绝 root 外目录');

assert(seen.tools.length === 11, `注册 11 个工具（实际 ${seen.tools.length}）`);
assert(Boolean(tool('foreman_gate')), '注册 foreman_gate');
assert(Boolean(tool('foreman_challenge')), '注册 foreman_challenge');
assert(Boolean(tool('foreman_project')), '注册 foreman_project');
assert(Boolean(tool('foreman_archive')), '注册 foreman_archive');
assert(Boolean(tool('foreman_reputation')), '注册 foreman_reputation');
assert(Boolean(seen.command) && seen.command.name === 'foreman', '注册 /foreman 命令');
assert(Boolean(seen.route) && seen.route.path === '/foreman/api', '注册只读路由');
assert(typeof seen.section.text === 'function', '注册 system prompt 简报段');
assert(typeof seen.agentCreated === 'function', '注册 agent/created listener');
const policyAgents = {
  reviewer: fakeAgent(reviewerId),
  nitpicker: fakeAgent(nitpickerId),
  archivist: fakeAgent(archivistId),
  builder: fakeAgent('builder-agent-smoke'),
  coder: fakeAgent('coder-agent-smoke'),
  unbound: fakeAgent(hostId),
};
for (const agent of Object.values(policyAgents)) seen.agentCreated({ agent });
const filterOf = (agent) => seen.filters.find((entry) => entry.agentId === agent.id)?.filter;
const reviewerFilter = filterOf(policyAgents.reviewer);
const archivistFilter = filterOf(policyAgents.archivist);
const builderFilter = filterOf(policyAgents.builder);
const coderFilter = filterOf(policyAgents.coder);
assert(reviewerFilter && reviewerFilter.allow && reviewerFilter.allow.includes('read') && reviewerFilter.allow.includes('foreman_status'), 'reviewer schema allow 读取/foreman');
assert(!reviewerFilter.allow.includes('write') && !reviewerFilter.allow.includes('pwsh') && !reviewerFilter.allow.includes('subagent') && !reviewerFilter.allow.includes('workflow'), 'reviewer schema 无越权工具');
assert(archivistFilter && archivistFilter.allow.includes('foreman_archive'), 'archivist schema 保留 archive');
assert(builderFilter && builderFilter.allow && !builderFilter.allow.includes('write') && !builderFilter.allow.includes('edit') && !builderFilter.allow.includes('str_replace_editor'), 'builder schema 隐藏 write/edit');
assert(builderFilter.allow.includes('pwsh') && builderFilter.allow.includes('job_output'), 'builder schema 保留 pwsh/job');
assert(coderFilter && coderFilter.deny.includes('foreman_verdict') && coderFilter.deny.includes('foreman_stage'), 'coder schema 隐藏 verdict/stage');
assert(!coderFilter.deny.includes('write'), 'coder 保留 write');
const coderChallenge = seen.scopedTools.find((entry) => entry.agentId === 'coder-agent-smoke');
assert(coderChallenge && coderChallenge.definition.parameters.properties.action.enum.join(',') === 'open,list', 'coder challenge schema 只有 open/list');
assert(!filterOf(policyAgents.unbound) && !seen.scopedTools.some((entry) => entry.agentId === hostId), '未绑定 agent schema 不变');
assert(typeof seen.agentDisposed === 'function', '注册 agent/disposed listener');
assert(typeof seen.toolsChange === 'function', '注册 tools/change listener');
const filterCountBeforeLate = seen.filters.length;
seen.lateTools.push('subagent', 'subagent_fork', 'workflow');
seen.toolsChange();
const latestReviewerFilter = seen.filters.filter((entry) => entry.agentId === reviewerId).at(-1)?.filter;
assert(seen.filters.length > filterCountBeforeLate, '工具延迟注册后重放 filter');
assert(latestReviewerFilter && latestReviewerFilter.allow && latestReviewerFilter.allow.includes('read'), '重放后 reviewer 仍保留读取');
assert(!latestReviewerFilter.allow.includes('subagent') && !latestReviewerFilter.allow.includes('subagent_fork') && !latestReviewerFilter.allow.includes('workflow'), '重放后 reviewer 最终 schema 无 subagent/subagent_fork/workflow');
assert(!latestReviewerFilter.allow.includes('write') && !latestReviewerFilter.allow.includes('pwsh'), '重放后 write/pwsh 仍隐藏');
const gateTool = tool('foreman_gate');
const challengeTool = tool('foreman_challenge');
const projectTool = tool('foreman_project');
const archiveTool = tool('foreman_archive');
const reputationTool = tool('foreman_reputation');
assert(gateTool.parameters.additionalProperties === false, 'gate 工具拒绝额外参数');
assert(!Object.prototype.hasOwnProperty.call(gateTool.parameters.properties, 'argv'), 'gate 工具没有 argv 入口');
assert(!Object.prototype.hasOwnProperty.call(gateTool.parameters.properties, 'shell'), 'gate 工具没有 shell 入口');
assert(challengeTool.parameters.additionalProperties === false, 'challenge 工具拒绝额外参数');
assert(projectTool.parameters.additionalProperties === false, 'project 工具拒绝额外参数');
assert(archiveTool.parameters.additionalProperties === false, 'archive 工具拒绝额外参数');
assert(reputationTool.parameters.additionalProperties === false, 'reputation 工具拒绝额外参数');

const initial = await foreman.snapshot();
assert(initial.roster.every((seat) => seat.agentId), '五席 roster 都有 agentId');
assert(initial.roster.find((seat) => seat.id === 'reviewer').agentId === reviewerId, 'reviewer agentId 绑定');
assert(initial.roster.find((seat) => seat.id === 'archivist').agentId === archivistId, 'archivist agentId 绑定');
assert(initial.state.seats.coder.agentId === 'coder-agent-smoke', 'state 五席落 agentId');
assert(foreman.brief.includes('@reviewer-agent-smoke'), 'brief 显示席位 agentId');
assert(foreman.brief.includes('五席：'), 'brief 文案为五席');
assert(typeof seen.guard === 'function', '注册 ctx.tools.guard');
const guard = seen.guard;
const denied = (name, agentId, args) => Boolean(guard({ name, agent: agentId ? { id: agentId } : undefined, arguments: args }));
assert(denied('write', reviewerId) && denied('pwsh', reviewerId) && denied('subagent', reviewerId), 'reviewer 拒 write/pwsh/subagent');
assert(!denied('foreman_status', reviewerId) && !denied('read', reviewerId), 'reviewer 放行 foreman_status/read');
assert(denied('write', nitpickerId) && denied('bash', nitpickerId), 'nitpicker 拒 write/bash');
assert(!denied('foreman_challenge', nitpickerId, { action: 'resolve' }), 'nitpicker 放行 challenge');
assert(denied('write', 'builder-agent-smoke'), 'builder 拒 write');
assert(!denied('pwsh', 'builder-agent-smoke') && !denied('job_output', 'builder-agent-smoke'), 'builder 放行 pwsh/job_*');
assert(denied('foreman_verdict', 'coder-agent-smoke') && denied('foreman_stage', 'coder-agent-smoke'), 'coder 拒 verdict/stage');
assert(!denied('write', 'coder-agent-smoke'), 'coder 放行 write');
assert(denied('foreman_challenge', 'coder-agent-smoke', { action: 'resolve' }), 'coder 拒 challenge resolve');
assert(!denied('foreman_challenge', 'coder-agent-smoke', { action: 'open' }), 'coder 放行 challenge open');
assert(denied('write', archivistId) && denied('pwsh', archivistId) && denied('subagent', archivistId), 'archivist 拒 write/pwsh/subagent');
assert(!denied('foreman_archive', archivistId) && !denied('read', archivistId), 'archivist 放行 archive/read');
assert(!denied('write', hostId) && !denied('pwsh', hostId), '未绑定 agent 不受限');

// M7.7：foreman_* 不再整类放行，按 seat/action 白名单
assert(
  denied('foreman_card', reviewerId, { action: 'upsert' })
  && denied('foreman_card', nitpickerId, { action: 'delete' })
  && denied('foreman_card', archivistId, { action: 'freeze' }),
  'reviewer/nitpicker/archivist 不能 card 变更',
);
assert(denied('foreman_card', 'coder-agent-smoke', { action: 'upsert' }), 'coder 也不能改契约（仅主持）');
assert(
  denied('foreman_stage', reviewerId, { stage: 'accept' })
  && denied('foreman_stage', archivistId, { stage: 'review' }),
  '只读席位不能推进 stage',
);
assert(
  denied('foreman_verdict', nitpickerId, { verdict: 'ACCEPT' })
  && denied('foreman_verdict', archivistId, { verdict: 'RETURN' }),
  'nitpicker/archivist 不能 verdict',
);
assert(!denied('foreman_verdict', reviewerId, { verdict: 'ACCEPT' }), 'reviewer 可 verdict');
assert(
  denied('foreman_archive', reviewerId, { action: 'remember' })
  && denied('foreman_archive', nitpickerId, { action: 'resolve' }),
  '非 archivist 不能 archive 变更',
);
assert(
  !denied('foreman_archive', reviewerId, { action: 'search' })
  && !denied('foreman_archive', nitpickerId, { action: 'list' })
  && !denied('foreman_archive', archivistId, { action: 'remember' }),
  'archive 只读可 search/list，archivist 可变更',
);
assert(
  denied('foreman_reputation', archivistId, { action: 'award' })
  && denied('foreman_reputation', reviewerId, { action: 'penalize' }),
  '席位不能 award/penalize',
);
assert(
  !denied('foreman_reputation', archivistId, { action: 'status' })
  && !denied('foreman_reputation', reviewerId, { action: 'list' }),
  '信誉只读可 status/list',
);
assert(
  denied('foreman_seat', reviewerId, { action: 'bind' })
  && denied('foreman_seat', archivistId, { action: 'rebind' }),
  'bind/rebind 只有主持',
);
assert(!denied('foreman_seat', reviewerId, { action: 'claim', seat: 'reviewer' }), 'claim 自己席位放行');
assert(denied('foreman_seat', reviewerId, { action: 'claim', seat: 'coder' }), 'claim 别人席位拒绝');

const rendered = tool('foreman_card').output.render({ id: 'X' }, { ok: true, card: { id: 'X' } });
assert(rendered[0].text.includes('"ok": true'), 'render(args, value) 输出 value 而不是 args');

const missingContract = await foreman.runGate({ gate: 'gate-smoke' }, {});
assert(missingContract.ok === false && /不存在/.test(missingContract.error), '无卡时 gate 拒绝');

const card = await tool('foreman_card').execute({
  id: 'G1',
  scopeDo: ['gate runner', 'evidence'],
  scopeNot: ['M3'],
  acceptance: ['gate passes'],
  gates: ['gate-smoke', 'gate-syntax'],
}, {});
assert(card.ok === true && card.card.id === 'G1', '建卡 G1');

const notInCard = await foreman.runGate({ gate: 'gate-selftest', cardId: 'G1' }, {});
assert(notInCard.ok === false && /不在任务卡/.test(notInCard.error), 'gate 不在卡上时拒绝');

await tool('foreman_card').execute({
  id: 'G2',
  gates: ['gate-unknown'],
  acceptance: ['unregistered gate'],
}, {});
const unknown = await foreman.runGate({ gate: 'gate-unknown', cardId: 'G2' }, {});
assert(unknown.ok === false && /未注册/.test(unknown.error), '卡上有 gate 但 config 未注册时拒绝');
await tool('foreman_card').execute({ id: 'G1', setCurrent: true }, {});

const cardA = await tool('foreman_card').execute({ id: 'A', gates: ['gate-cross'], acceptance: ['A gate'] }, {});
const cardB = await tool('foreman_card').execute({ id: 'B', gates: ['gate-cross'], acceptance: ['B gate'] }, {});
scenario = { exitCode: 1, stdout: '', stderr: 'A failed', tamper: false, hang: false };
const aFail = await gateTool.execute({ gate: 'gate-cross', cardId: 'A' }, {});
assert(aFail.p0.some((item) => item.cardId === 'A' && item.gate === 'gate-cross'), 'A gate 失败 P0 带 cardId');
scenario = { exitCode: 0, stdout: 'B ok', stderr: '', tamper: false, hang: false };
const bOk = await gateTool.execute({ gate: 'gate-cross', cardId: 'B' }, {});
assert(bOk.p0.some((item) => item.cardId === 'A' && item.gate === 'gate-cross'), 'B 同名 gate 成功不清 A 的 P0');
assert(aFail.p0.length > 0 && bOk.p0.length > 0, '跨卡 P0 隔离');
const aBlocked = await tool('foreman_verdict').execute({ cardId: 'A', verdict: 'ACCEPT', summary: 'B 成功也不行' }, {});
assert(aBlocked.ok === false && /P0 未清零/.test(aBlocked.error), 'B 成功不能放行 A');

scenario = { exitCode: 0, stdout: 'A pass 1', stderr: '', tamper: false, hang: false };
const aPass1 = await gateTool.execute({ gate: 'gate-cross', cardId: 'A' }, {});
assert(aPass1.p0.length === 0, 'A 重跑成功清 A P0');
scenario = { exitCode: 2, stdout: '', stderr: 'A failed latest', tamper: false, hang: false };
const aFail2 = await gateTool.execute({ gate: 'gate-cross', cardId: 'A' }, {});
assert(aFail2.p0.some((item) => item.cardId === 'A' && item.gate === 'gate-cross'), 'A 旧 pass 后新失败产生 P0');
const missingA = await foreman.missingGates('A', cardA.card);
assert(missingA.includes('gate-cross'), 'missingGates 取最新 gate 证据，旧 pass 不放行');
const aBlocked2 = await tool('foreman_verdict').execute({ cardId: 'A', verdict: 'ACCEPT', summary: '旧 pass 想混过' }, {});
assert(aBlocked2.ok === false && /P0 未清零|证据缺失|未通过/.test(aBlocked2.error), 'A 先 pass 后 fail 仍不能 ACCEPT');
scenario = { exitCode: 0, stdout: 'A cleanup', stderr: '', tamper: false, hang: false };
const aClean = await gateTool.execute({ gate: 'gate-cross', cardId: 'A' }, {});
assert(aClean.p0.length === 0, 'A 最终成功清理 P0');

await tool('foreman_card').execute({ id: 'T', gates: ['gate-no-tests'], acceptance: ['missing root'] }, {});
const missingRoot = await gateTool.execute({ gate: 'gate-no-tests', cardId: 'T' }, {});
assert(missingRoot.ok === false && /testsRoot.*快照失败/.test(missingRoot.error), 'testsRoot 缺失拒绝执行');
assert(missingRoot.p0.some((item) => item.cardId === 'T' && item.gate === 'gate-no-tests'), 'testsRoot 缺失 P0 带 cardId/gate');
const tBlocked = await tool('foreman_verdict').execute({ cardId: 'T', verdict: 'ACCEPT', summary: 'missing root' }, {});
assert(tBlocked.ok === false && /P0 未清零/.test(tBlocked.error), 'testsRoot 缺失不能 ACCEPT');
await mkdir(join(root, 'missing-tests'), { recursive: true });
await writeFile(join(root, 'missing-tests', 'sample.test.mjs'), '// now exists\n', 'utf8');
scenario = { exitCode: 0, stdout: 'T ok', stderr: '', tamper: false, hang: false };
const tFixed = await gateTool.execute({ gate: 'gate-no-tests', cardId: 'T' }, {});
assert(tFixed.ok === true && tFixed.p0.length === 0, '补齐 testsRoot 后重跑清 P0');

await tool('foreman_card').execute({ id: 'G1', setCurrent: true }, {});

const reportOnly = await tool('foreman_evidence').execute({
  gate: 'gate-smoke', cardId: 'G1', cmd: 'reported smoke', exitCode: 0, output: 'called it a pass',
}, {});
assert(reportOnly.ok === true && reportOnly.entry.source === 'reported', 'reported 证据仍可登记');
const reportBlocked = await tool('foreman_verdict').execute({ cardId: 'G1', verdict: 'ACCEPT', summary: 'reported 放行？' }, {});
assert(reportBlocked.ok === false && /证据缺失|未通过/.test(reportBlocked.error), 'reported exit0 不能通过 ACCEPT');

const success = await gateTool.execute({ gate: 'gate-smoke', cardId: 'G1', timeoutMs: 500 }, { agent: { id: 'smoke' } });
assert(success.ok === true && success.exitCode === 0, 'gate 成功运行');
assert(success.entry.source === 'gate' && success.entry.exitCode === 0, '成功证据 source=gate / exit0');
assert(success.entry.argv[0] === 'node' && success.entry.cwd === root, 'gate 证据记录 argv/cwd');
assert(success.entry.root === root && success.entry.cwdSpec === root && success.entry.outsideRoot === false, 'gate 证据记录 root/cwdSpec/outsideRoot');
assert(success.entry.durationMs >= 0 && success.entry.tampered === false, 'gate 证据 durationMs/tampered');
assert(Array.isArray(success.entry.changedFiles) && success.entry.changedFiles.length === 0, 'M7.15 未篡改 changedFiles 为空');
assert(Array.isArray(success.entry.codeFiles) && success.entry.codeFiles.length > 0, 'M7.15 成功证据带 codeFiles');
assert(Array.isArray(success.entry.testsFiles) && success.entry.testsFiles.length > 0, 'M7.15 成功证据带 testsFiles');
assert(typeof success.entry.codeHash === 'string' && success.entry.codeHash.length === 64, 'gate 证据带 codeHash');
assert(typeof success.entry.specHash === 'string' && success.entry.specHash.length === 64, 'gate 证据带 specHash');
assert(success.entry.testsRoot === 'test', 'gate spec 的 testsRoot 被记录');
assert(String(success.entry.testsDir).replace(/\\/g, '/').endsWith('/test'), '快照扫描 gate 指定的测试目录');
assert(success.p0.length === 0, '成功 gate 无 P0');
assert(spawnLog.at(-1).argv[0] === 'node' && spawnLog.at(-1).cwd === root, 'spawn 只接收注册 argv/cwd');
assert(spawnLog.at(-1).stdio.stdin === 'ignore', 'spawn 不接 stdin');

scenario = { exitCode: 2, stdout: 'bad stdout', stderr: 'bad stderr', tamper: false, hang: false };
const failure = await gateTool.execute({ gate: 'gate-syntax', cardId: 'G1', timeoutMs: 500 }, {});
assert(failure.ok === true && failure.exitCode === 2, 'gate 非 0 返回 exitCode');
assert(failure.p0.some((item) => item.gate === 'gate-syntax'), 'gate 非 0 自动 P0');
assert(failure.entry.source === 'gate' && failure.entry.exitCode === 2, '失败证据 source=gate / exit2');
const reportedCannotClear = await tool('foreman_evidence').execute({
  gate: 'gate-syntax', cardId: 'G1', exitCode: 0, cmd: 'reported retry', output: 'trust me',
}, {});
assert(reportedCannotClear.p0.some((item) => item.gate === 'gate-syntax' && item.source === 'gate'), 'reported exit0 不能清 gate P0');
const blocked = await tool('foreman_verdict').execute({ cardId: 'G1', verdict: 'ACCEPT', summary: '带 P0' }, {});
assert(blocked.ok === false && /P0 未清零/.test(blocked.error), '失败 gate 的 P0 阻断 ACCEPT');

scenario = { exitCode: 0, stdout: 'fixed', stderr: '', tamper: false, hang: false };
const retry = await gateTool.execute({ gate: 'gate-syntax', cardId: 'G1', timeoutMs: 500 }, {});
assert(retry.ok === true && retry.p0.length === 0, '同 gate 重跑 exit0 清掉该 gate P0');

scenario = { exitCode: 0, stdout: '', stderr: '', tamper: false, hang: true };
const timedOut = await gateTool.execute({ gate: 'gate-smoke', cardId: 'G1', timeoutMs: 25 }, {});
assert(timedOut.ok === true && timedOut.timedOut === true, 'gate 超时被记录');
assert(timedOut.exitCode === null && timedOut.entry.exitCode === null, '超时 exitCode=null');
assert(timedOut.p0.some((item) => /超时/.test(item.text)), '超时自动 P0');
scenario = { exitCode: 0, stdout: 'after timeout', stderr: '', tamper: false, hang: false };
const timeoutRetry = await gateTool.execute({ gate: 'gate-smoke', cardId: 'G1', timeoutMs: 500 }, {});
assert(timeoutRetry.p0.length === 0, '超时后重跑成功清 P0');

scenario = { exitCode: 0, stdout: 'tampered run', stderr: '', tamper: true, hang: false };
const tampered = await gateTool.execute({ gate: 'gate-smoke', cardId: 'G1', timeoutMs: 500 }, {});
assert(tampered.ok === true && tampered.exitCode === 0 && tampered.tampered === true, '篡改即使 exit0 也标记');
assert(tampered.entry.tampered === true, '篡改证据 tampered=true');
assert(tampered.p0.some((item) => /tampered/.test(item.text)), '篡改自动 P0');
const tamperBlocked = await tool('foreman_verdict').execute({ cardId: 'G1', verdict: 'ACCEPT', summary: '篡改想过' }, {});
assert(tamperBlocked.ok === false && /P0 未清零|证据缺失|未通过/.test(tamperBlocked.error), '篡改拒绝 ACCEPT');
assert(tampered.entry.testsHashBefore !== tampered.entry.testsHashAfter, '记录 tests hash 前后');
assert(Array.isArray(tampered.entry.changedFiles) && tampered.entry.changedFiles.length > 0, 'M7.15 篡改证据 changedFiles 非空');
assert(Array.isArray(tampered.entry.testsFiles) && tampered.entry.testsFiles.length > 0, 'M7.15 证据带 testsFiles 逐文件哈希');
assert(Array.isArray(tampered.entry.codeFiles) && tampered.entry.codeFiles.length > 0, 'M7.15 证据带 codeFiles 逐文件哈希');

await writeFile(testFile, testContent, 'utf8');
scenario = { exitCode: 0, stdout: 'clean', stderr: '', tamper: false, hang: false };
const clean = await gateTool.execute({ gate: 'gate-smoke', cardId: 'G1', timeoutMs: 500 }, {});
assert(clean.ok === true && clean.tampered === false && clean.p0.length === 0, '恢复测试后重跑清 P0/tamper');

// M7.18：gate spec artifacts 通配收集
await mkdir(join(root, 'dist', 'assets'), { recursive: true });
await writeFile(join(root, 'dist', 'index.html'), '<html>dist index</html>\n', 'utf8');
await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log("dist app");\n', 'utf8');
const artifactsSpec = normalized['gate-artifacts'];
assert(
  artifactsSpec && JSON.stringify(artifactsSpec.artifacts) === JSON.stringify(['dist/**', 'nope/**', 'missing-dir/**']),
  'config gate spec 归一化 artifacts',
);
assert(gateSpecHash(artifactsSpec) !== gateSpecHash({ ...artifactsSpec, artifacts: [] }), 'specHash 含 artifacts');
assert(gateSpecHash(artifactsSpec) === gateSpecHash({ ...artifactsSpec, name: 'x' }), 'specHash 对相同 spec 稳定');

const directArtifacts = await collectArtifacts(root, root, ['dist/**', 'nope/**', 'missing-dir/**']);
assert(directArtifacts.length === 2, 'collectArtifacts 只收集匹配文件');
assert(directArtifacts.every((item) => item.path.startsWith('dist/')), 'artifact path 相对 root');
assert(
  directArtifacts.every((item) => typeof item.sha256 === 'string' && item.sha256.length === 16 && typeof item.bytes === 'number' && item.bytes > 0),
  'artifact 带 sha256/bytes（与手工产物 files 条目格式一致）',
);
assert((await collectArtifacts(root, root, ['no-such/**'])).length === 0, '不存在的 pattern 不报错返回空');

await tool('foreman_card').execute({ id: 'G3', gates: ['gate-artifacts'], acceptance: ['artifacts into evidence'], setCurrent: false }, {});
scenario = { exitCode: 0, stdout: 'artifacts ok', stderr: '', tamper: false, hang: false };
const artRun = await gateTool.execute({ gate: 'gate-artifacts', cardId: 'G3', timeoutMs: 500 }, {});
assert(artRun.ok === true && artRun.exitCode === 0, '带 artifacts 的 gate 正常通过');
assert(Array.isArray(artRun.entry.files) && artRun.entry.files.length === 2, 'gate 跑完把匹配文件登记进 evidence files');
assert(
  artRun.entry.files.some((item) => item.path === 'dist/index.html' && item.bytes > 0 && /^[0-9a-f]{16}$/.test(item.sha256)),
  'dist/index.html 登记 path/sha256/bytes',
);
assert(artRun.entry.files.some((item) => item.path === 'dist/assets/app.js'), 'dist/assets/app.js 也被登记');
assert(artRun.entry.files.every((item) => !item.path.includes(root)), 'path 相对 root 无绝对前缀');
assert(JSON.stringify(artRun.entry.artifacts) === JSON.stringify(['dist/**', 'nope/**', 'missing-dir/**']), '证据记录 gate artifacts 配置');
assert(artRun.entry.specHash === gateSpecHash(artifactsSpec), '证据 specHash 与 spec 一致');
assert(artRun.p0.length === 0, '不匹配/不存在的 artifacts 不产生 P0');
assert(Array.isArray(clean.entry.files) && clean.entry.files.length === 0, '无 artifacts 的 gate files 为空行为不变');

// M7.3：gate cwd 绑定 active root，越界默认拒绝，显式 allowOutsideRoot 例外
const cwdCard = await tool('foreman_card').execute({
  id: 'CWD',
  gates: ['gate-relative', 'gate-outside-default', 'gate-outside-allow'],
  acceptance: ['gate cwd bound to active root'],
  setCurrent: false,
}, {});
assert(cwdCard.ok === true, '建 CWD 卡（不抢当前卡）');
assert((await foreman.snapshot()).card.id === 'G1', 'CWD 卡不影响当前卡');

scenario = { exitCode: 0, stdout: 'relative cwd', stderr: '', tamper: false, hang: false };
const relativeGate = await gateTool.execute({ gate: 'gate-relative', cardId: 'CWD', timeoutMs: 500 }, {});
assert(relativeGate.ok === true && relativeGate.exitCode === 0, '相对 cwd gate 可跑');
assert(relativeGate.entry.root === root && relativeGate.entry.cwd === root, '相对 cwd 证据记录 root/cwd');
assert(relativeGate.cwd === root && relativeGate.cwdSpec === '.', 'gate 返回解析后的 cwd/spec');

const spawnsBeforeOutside = spawnLog.length;
const evidenceBeforeOutside = (await foreman.snapshot()).evidenceCount;
const outsideDefault = await gateTool.execute({ gate: 'gate-outside-default', cardId: 'CWD' }, {});
assert(outsideDefault.ok === false && /不在当前 active root 内/.test(outsideDefault.error), 'root 外绝对 cwd 默认拒绝');
assert(outsideDefault.blocked === 'gate-cwd-outside-root', '越界拒绝带 blocked 原因');
assert(outsideDefault.root === root && outsideDefault.cwd === outsideDir, '越界拒绝回显 root/cwd');
assert(spawnLog.length === spawnsBeforeOutside, '越界 gate 不 spawn');
assert((await foreman.snapshot()).evidenceCount === evidenceBeforeOutside, '越界 gate 不写证据');
assert(!(await foreman.state()).p0.some((item) => item.gate === 'gate-outside-default'), '越界拒绝不写 P0');

scenario = { exitCode: 0, stdout: 'outside allowed', stderr: '', tamper: false, hang: false };
const outsideAllowed = await gateTool.execute({ gate: 'gate-outside-allow', cardId: 'CWD', timeoutMs: 500 }, {});
assert(outsideAllowed.ok === true && outsideAllowed.entry.exitCode === 0, 'allowOutsideRoot gate 放行');
assert(outsideAllowed.entry.root === root && outsideAllowed.entry.cwd === outsideDir, '放行证据记录 root/cwd');
assert(outsideAllowed.entry.outsideRoot === true && outsideAllowed.entry.allowOutsideRoot === true, '放行证据标记 outsideRoot/allowOutsideRoot');
assert(spawnLog.at(-1).cwd === outsideDir, '放行 gate 在配置 cwd 执行');

await writeFile(join(root, 'PROGRESS.md'), '# changed source\n', 'utf8');
const staleSource = await tool('foreman_verdict').execute({ cardId: 'G1', verdict: 'ACCEPT', summary: '源码变了' }, {});
assert(staleSource.ok === false && /证据缺失|未通过/.test(staleSource.error), 'gate 后改源码旧证据不放行');
await writeFile(join(root, 'PROGRESS.md'), '# 冒烟产物\n', 'utf8');

const savedArgv = gateConfig['gate-smoke'].argv.pop();
gateConfig['gate-smoke'].argv.push('--changed');
const staleArgv = await tool('foreman_verdict').execute({ cardId: 'G1', verdict: 'ACCEPT', summary: 'argv 变了' }, {});
assert(staleArgv.ok === false && /证据缺失|未通过/.test(staleArgv.error), 'gate 后改 argv 旧证据不放行');
gateConfig['gate-smoke'].argv.pop();
if (savedArgv !== undefined) gateConfig['gate-smoke'].argv.push(savedArgv);

const beforeConcurrent = (await foreman.snapshot()).evidenceCount;
scenario = { exitCode: 0, stdout: 'concurrent', stderr: '', tamper: false, hang: false };
const [parallelA, parallelB] = await Promise.all([
  gateTool.execute({ gate: 'gate-smoke', cardId: 'G1', timeoutMs: 500 }, {}),
  gateTool.execute({ gate: 'gate-syntax', cardId: 'G1', timeoutMs: 500 }, {}),
]);
const afterConcurrent = (await foreman.snapshot()).evidenceCount;
assert(parallelA.ok === true && parallelB.ok === true, '两个 gate 并发都完成');
assert(parallelA.entry.id !== parallelB.entry.id, '并发 gate 使用不同 evidence id');
assert(afterConcurrent === beforeConcurrent + 2, '并发 gate 不丢 evidence');

const accepted = await tool('foreman_verdict').execute({ cardId: 'G1', verdict: 'ACCEPT', summary: 'gate 证据齐全' }, {});
assert(accepted.ok === true && accepted.verdict === 'ACCEPT', '两个 gate 都有 source=gate exit0 后可 ACCEPT');

// M7.7：业务入口双保险（直接调工具、绕过 guard 也拒绝）
const reviewerCardWrite = await tool('foreman_card').execute(
  { id: 'DENY7', gates: [], acceptance: ['x'] },
  { agent: { id: reviewerId } },
);
assert(reviewerCardWrite.ok === false && /主持/.test(reviewerCardWrite.error), 'reviewer 业务入口不能 upsert 卡');
const nitpickerDelete = await tool('foreman_card').execute(
  { action: 'delete', id: 'G1' },
  { agent: { id: nitpickerId } },
);
assert(nitpickerDelete.ok === false && /主持/.test(nitpickerDelete.error), 'nitpicker 业务入口不能 delete 卡');
const archivistFreeze = await tool('foreman_card').execute(
  { action: 'freeze', id: 'G1', signedBy: 'x' },
  { agent: { id: archivistId } },
);
assert(archivistFreeze.ok === false && /主持/.test(archivistFreeze.error), 'archivist 业务入口不能 freeze 卡');
assert((await foreman.snapshot()).cards.some((item) => item.id === 'G1'), '越权 delete/freeze 未生效，G1 仍在');
const reviewerStage = await tool('foreman_stage').execute({ stage: 'implement' }, { agent: { id: reviewerId } });
assert(reviewerStage.ok === false && /主持/.test(reviewerStage.error), 'reviewer 业务入口不能推进 stage');
const v7 = await tool('foreman_card').execute(
  { id: 'V7', gates: [], acceptance: ['verdict role'], setCurrent: false },
  {},
);
assert(v7.ok === true, '建 V7 供 verdict 权限测试');
const nitVerdict = await tool('foreman_verdict').execute(
  { cardId: 'V7', verdict: 'RETURN', summary: 'nitpicker no' },
  { agent: { id: nitpickerId } },
);
const archVerdict = await tool('foreman_verdict').execute(
  { cardId: 'V7', verdict: 'RETURN', summary: 'archivist no' },
  { agent: { id: archivistId } },
);
assert(nitVerdict.ok === false && archVerdict.ok === false && /Reviewer|主持/.test(nitVerdict.error), 'nitpicker/archivist 业务入口不能 verdict');
const reviewerVerdict = await tool('foreman_verdict').execute(
  { cardId: 'V7', verdict: 'RETURN', summary: 'reviewer return' },
  { agent: { id: reviewerId } },
);
assert(reviewerVerdict.ok === true && reviewerVerdict.verdict === 'RETURN', 'reviewer 业务入口可 verdict');

const h1 = await tool('foreman_card').execute({
  id: 'H1',
  gates: ['gate-smoke', 'gate-syntax', 'gate-cross'],
  acceptance: ['challenge flow'],
}, {});
assert(h1.ok === true, '建挑战卡 H1');
scenario = { exitCode: 0, stdout: 'H1 gates', stderr: '', tamper: false, hang: false };
for (const gate of ['gate-smoke', 'gate-syntax', 'gate-cross']) {
  const result = await gateTool.execute({ gate, cardId: 'H1', timeoutMs: 500 }, {});
  assert(result.ok === true && result.exitCode === 0, `H1 ${gate} 先通过`);
}

const autoOpen = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: 'Reviewer 提交' },
  { agent: { id: reviewerId } },
);
assert(autoOpen.ok === false && autoOpen.challengeOpened === true, 'Reviewer ACCEPT 自动开挑战');
assert(/ACCEPT 已受理/.test(autoOpen.error), '自动开挑战文案为「ACCEPT 已受理」而非失败');
assert(autoOpen.challenge.status === 'open' && autoOpen.challenge.openedBy === reviewerId, '自动挑战 open 且记录 reviewer');
const openSnapshot = await foreman.snapshot();
assert(openSnapshot.openChallengeCount === 1, 'snapshot 显示 open challenge 数');
const openStatus = await seen.command.handler({ rawInput: 'status' });
assert(openStatus.kind === 'success' && openStatus.text.includes('挑战：open'), 'status 显示 open challenge');
const openBrief = foreman.brief;
assert(openBrief.includes('挑战：open'), 'brief 显示 open challenge');
const openResume = await seen.command.handler({ rawInput: 'resume' });
assert(openResume.kind === 'success' && openResume.text.includes('挑战：open'), 'resume 恢复 open challenge');

const duplicateOpen = await challengeTool.execute({ action: 'open', cardId: 'H1' }, { agent: { id: hostId } });
assert(duplicateOpen.ok === true && duplicateOpen.existing === true && duplicateOpen.challenge.id === autoOpen.challenge.id, '重复 open 返回已有挑战');
const anySourceBlocked = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: '主持也想过' },
  { agent: { id: hostId } },
);
assert(anySourceBlocked.ok === false && anySourceBlocked.challengeOpen === true, '任何来源 open 挑战时 ACCEPT 被拒');
const wrongResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'H1', decision: 'cleared' },
  { agent: { id: reviewerId } },
);
assert(wrongResolve.ok === false && /只有 Nitpicker/.test(wrongResolve.error), 'Reviewer 不能 resolve challenge');
const blockedResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'H1', decision: 'blocked', note: '仍有假通过' },
  { agent: { id: nitpickerId } },
);
assert(blockedResolve.ok === true && blockedResolve.challenge.status === 'blocked', 'Nitpicker 将挑战 resolve 为 blocked');
const repeatResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'H1', decision: 'cleared' },
  { agent: { id: nitpickerId } },
);
assert(repeatResolve.ok === false && /没有 open challenge/.test(repeatResolve.error), '重复 resolve 被拒');
const blockedAccept = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: 'blocked 后硬闯' },
  { agent: { id: reviewerId } },
);
assert(blockedAccept.ok === false && blockedAccept.challengeBlocked === true, 'blocked 后 ACCEPT 拒绝');

const reopened = await challengeTool.execute({ action: 'open', cardId: 'H1', note: '复审' }, { agent: { id: hostId } });
assert(reopened.ok === true && reopened.existing === false && reopened.challenge.status === 'open', 'blocked 后主持重新 open');
const clearedResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'H1', decision: 'cleared', note: '已复核' },
  { agent: { id: nitpickerId } },
);
assert(clearedResolve.ok === true && clearedResolve.challenge.status === 'cleared', 'Nitpicker resolve cleared');
const repeatCleared = await challengeTool.execute(
  { action: 'resolve', cardId: 'H1', decision: 'cleared' },
  { agent: { id: nitpickerId } },
);
assert(repeatCleared.ok === false, 'cleared 后重复 resolve 被拒');
const finalAccept = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: '挑战闭环完成' },
  { agent: { id: reviewerId } },
);
assert(finalAccept.ok === true && finalAccept.verdict === 'ACCEPT', 'open+cleared 后 Reviewer 可 ACCEPT');
const challengeList = await challengeTool.execute({ action: 'list', cardId: 'H1' }, {});
assert(challengeList.ok === true && challengeList.entries.filter((entry) => entry.status === 'blocked').length === 1, 'challenge list 按卡返回');
assert(foreman.brief.includes('挑战：无 open'), 'brief 显示挑战已关闭');

const archive1 = await archiveTool.execute({
  action: 'remember',
  cardId: 'H1',
  fingerprint: 'trap-fp-1',
  area: 'gate-runner',
  symptom: 'flaky gate',
  repro: 'run twice',
  rootCause: 'shared state',
  fix: 'isolate',
}, { agent: { id: archivistId } });
assert(archive1.ok === true && archive1.existing === false && archive1.entry.seenCount === 1, 'archive remember 新建 open');
const archive2 = await archiveTool.execute({
  action: 'remember',
  cardId: 'H1',
  fingerprint: 'trap-fp-1',
}, { agent: { id: archivistId } });
assert(archive2.ok === true && archive2.existing === true && archive2.entry.seenCount === 2, 'archive 同 fingerprint 去重并 seenCount++');
const archiveOpenBlock = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: 'open archive' },
  { agent: { id: hostId } },
);
assert(archiveOpenBlock.ok === false && archiveOpenBlock.archiveOpen === true, '当前卡 open 归档阻断 ACCEPT');
const noGuard = await archiveTool.execute({
  action: 'resolve', id: archive1.entry.id, status: 'fixed',
}, { agent: { id: archivistId } });
assert(noGuard.ok === false && /regressionGuard/.test(noGuard.error), 'fixed resolve 无 regressionGuard 拒绝');
const reviewerResolve = await archiveTool.execute({
  action: 'resolve', id: archive1.entry.id, status: 'wontfix',
}, { agent: { id: reviewerId } });
assert(reviewerResolve.ok === false && /archivist|主持/.test(reviewerResolve.error), 'reviewer 不能 resolve archive');
const reviewerRemember = await archiveTool.execute({
  action: 'remember', cardId: 'H1', fingerprint: 'deny-fp', symptom: 'should not write',
}, { agent: { id: reviewerId } });
assert(reviewerRemember.ok === false && /archivist|主持/.test(reviewerRemember.error), 'reviewer 业务入口不能 archive remember');
const reviewerArchiveSearch = await archiveTool.execute(
  { action: 'search', cardId: 'H1' },
  { agent: { id: reviewerId } },
);
assert(reviewerArchiveSearch.ok === true, 'reviewer 业务入口可 archive search');
const fixed1 = await archiveTool.execute({
  action: 'resolve', id: archive1.entry.id, status: 'fixed', regressionGuard: 'gate-runner smoke',
}, { agent: { id: archivistId } });
assert(fixed1.ok === true && fixed1.entry.status === 'fixed' && fixed1.entry.regressionGuard === 'gate-runner smoke', 'archivist 带 guard resolve fixed');
assert(
  typeof fixed1.entry.resolvedAt === 'number' && fixed1.entry.resolvedBy === archivistId,
  'M7.12 fixed 首轮记录 resolvedAt/resolvedBy',
);
const afterFixed = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: 'archive fixed' },
  { agent: { id: hostId } },
);
assert(afterFixed.ok === true, 'resolve 后 ACCEPT 放行');
const recurrence = await archiveTool.execute({
  action: 'remember', cardId: 'H1', fingerprint: 'trap-fp-1', symptom: 'back again',
}, { agent: { id: archivistId } });
assert(recurrence.ok === true && recurrence.recurrence === true && recurrence.entry.status === 'open', 'fixed 后同 fingerprint 复发并 reopen');
assert(
  recurrence.entry.resolvedAt === null
  && recurrence.entry.resolvedBy === null
  && recurrence.entry.decision === null,
  'M7.12 复发 reopen 清空 resolvedAt/resolvedBy/decision',
);
assert(recurrence.p0.some((item) => item.source === 'archive' && item.archiveId === recurrence.entry.id), '复发自动 P0');
const recurrenceAccept = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: '复发' },
  { agent: { id: hostId } },
);
assert(recurrenceAccept.ok === false && (recurrenceAccept.archiveOpen === true || /P0 未清零/.test(recurrenceAccept.error)), '复发/开放归档阻断 ACCEPT');
const fixed2 = await archiveTool.execute({
  action: 'resolve', id: recurrence.entry.id, status: 'fixed', regressionGuard: 'regression test guard',
}, { agent: { id: archivistId } });
assert(fixed2.ok === true && !fixed2.p0.some((item) => item.source === 'archive'), 'resolve fixed 清 archive P0');
assert(
  fixed2.entry.status === 'fixed'
  && typeof fixed2.entry.resolvedAt === 'number'
  && fixed2.entry.resolvedBy === archivistId
  && fixed2.entry.decision === null,
  'M7.12 open→fixed→recurrence→fixed 状态机收尾',
);
const archiveList = await archiveTool.execute({ action: 'list', cardId: 'H1' }, {});
assert(archiveList.ok === true && archiveList.entries.length === 0, 'list 默认只看 open');
const archiveSearch = await archiveTool.execute({ action: 'search', fingerprint: 'trap-fp-1', cardId: 'H1' }, {});
assert(archiveSearch.ok === true && archiveSearch.entries[0].status === 'fixed', 'search 可查历史 fixed');
const lessons = await readFile(join(root, 'LESSONS.md'), 'utf8').catch(() => '');
assert(lessons.includes('trap-fp-1'), '生成 LESSONS.md');

const k2 = await tool('foreman_card').execute({ id: 'K2', gates: [], acceptance: ['cross card'] }, {});
assert(k2.ok === true, '建跨卡 K2');
const otherCardArchive = await archiveTool.execute({ action: 'list', cardId: 'K2' }, {});
assert(otherCardArchive.ok === true && otherCardArchive.entries.length === 0, '跨卡归档不污染');

assert(defaultSharedLessonsPath().endsWith(join('foreman', 'shared', 'lessons.json')), '公共经验默认 DSH_HOME 路径');
assert(resolveSharedLessonsPath('relative/lessons.json').ok === false, '公共经验路径必须是绝对路径');
const sanitizedP0 = sanitizeSharedText('P0 假绿 + P1 越权，卡 G1 与 M2-03', { cardId: 'G1', projectName: 'demo' });
assert(sanitizedP0.includes('P0') && sanitizedP0.includes('P1'), 'sanitize 保留 P0/P1 finding 级别');
assert(
  sanitizedP0.includes('[card]') && !sanitizedP0.includes('G1') && !sanitizedP0.includes('M2-03'),
  'sanitize 仍脱敏真实卡号样式',
);
const sanitizedP2 = sanitizeSharedText('P2 可延后；P0/P1 阻断');
assert(sanitizedP2.includes('P2') && sanitizedP2.includes('P0/P1'), 'sanitize P2/P0/P1 原样保留');
const sanitizedFieldNames = sanitizeSharedText(
  '只保留 pattern/area/symptom/rootCause/fixPattern/regressionGuard；字段 /area/ /symptom/ 不是路径',
  { root, cardId: 'H1', projectName: basename(root) },
);
assert(
  !sanitizedFieldNames.includes('[path]')
  && sanitizedFieldNames.includes('pattern/area/symptom/rootCause/fixPattern/regressionGuard')
  && sanitizedFieldNames.includes('/area/')
  && sanitizedFieldNames.includes('/symptom/'),
  'M7.12 sanitize 不把字段名斜杠列表当路径',
);
const sanitizedPaths = sanitizeSharedText(
  `根 ${root}；盘 C:\\temp\\leak.ts；UNC \\\\server\\share\\leak.txt；POSIX /home/user/secret`,
  { root, cardId: 'H1', projectName: basename(root) },
);
assert(
  !sanitizedPaths.includes(root)
  && !sanitizedPaths.includes('C:\\temp')
  && !sanitizedPaths.includes('\\\\server')
  && !sanitizedPaths.includes('/home/user'),
  'M7.12 sanitize 替换 root/盘符/UNC/POSIX 绝对路径',
);
assert((sanitizedPaths.match(/\[path\]/g) || []).length >= 4, 'M7.12 sanitize 四类真实路径都替换');
const sensitiveRoot = root;
const sensitiveProject = basename(root);
const sensitive = await archiveTool.execute({
  action: 'remember',
  cardId: 'H1',
  fingerprint: 'shared-fp-1',
  area: 'shared-area',
  symptom: `fails at ${sensitiveRoot} on card H1 in ${sensitiveProject}`,
  repro: `project ${sensitiveProject}`,
  rootCause: `path ${sensitiveRoot} card H1`,
  fix: `fix at ${sensitiveRoot}`,
  regressionGuard: 'guard shared',
}, { agent: { id: archivistId } });
assert(sensitive.ok === true && sensitive.entry.status === 'open', 'M6 新建待 promote 归档');
const promoted = await archiveTool.execute(
  { action: 'promote', id: sensitive.entry.id, cardId: 'H1' },
  { agent: { id: archivistId } },
);
assert(promoted.ok === true && promoted.lesson && promoted.lesson.pattern, 'promote 生成公共经验');
const lessonKeys = Object.keys(promoted.lesson);
assert(!lessonKeys.includes('cardId') && !lessonKeys.includes('repro') && !lessonKeys.includes('fix'), 'promote 只保留允许字段');
const lessonText = JSON.stringify(promoted.lesson);
assert(!lessonText.includes(sensitiveRoot) && !lessonText.includes(sensitiveProject) && !lessonText.includes('H1'), 'promote 剥路径/项目名/卡号');
assert(promoted.lesson.area === 'shared-area' && promoted.lesson.fixPattern, 'promote 保留 area/fixPattern');
const openBlock = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: 'project open archive' },
  { agent: { id: hostId } },
);
assert(openBlock.ok === false && openBlock.archiveOpen === true, '项目 open 仍只阻断本项目（H1）');
const resolvedSensitive = await archiveTool.execute(
  { action: 'resolve', id: sensitive.entry.id, status: 'fixed', regressionGuard: 'shared guard' },
  { agent: { id: archivistId } },
);
assert(resolvedSensitive.ok === true, 'resolve 项目归档');
const globalOnly = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: 'global lesson only prompt' },
  { agent: { id: hostId } },
);
assert(globalOnly.ok === true, '公共经验只提示不阻断 ACCEPT');
const promoteAgain = await archiveTool.execute(
  { action: 'promote', id: sensitive.entry.id, cardId: 'H1' },
  { agent: { id: archivistId } },
);
assert(promoteAgain.ok === true && promoteAgain.existing === true, '公共经验 fingerprint 去重');
assert((await foreman.snapshot()).sharedLessonCount === 1, '面板快照公共经验条数');
assert(foreman.brief.includes('[公共]') && foreman.brief.includes('公共经验'), 'brief 注入公共经验来源');
const globalList = await archiveTool.execute({ action: 'list', scope: 'global' }, {});
assert(globalList.ok === true && globalList.globalLessons.length === 1, 'scope=global list');
const bothList = await archiveTool.execute({ action: 'list', scope: 'both' }, {});
assert(bothList.ok === true && bothList.globalLessons.length === 1 && Array.isArray(bothList.projectEntries), 'scope=both list');
const demoted = await archiveTool.execute(
  { action: 'demote', id: promoted.lesson.id },
  { agent: { id: archivistId } },
);
assert(demoted.ok === true && (await foreman.snapshot()).sharedLessonCount === 0, 'demote 删除公共经验');
const rePromoted = await archiveTool.execute(
  { action: 'promote', id: sensitive.entry.id, cardId: 'H1' },
  { agent: { id: archivistId } },
);
assert(rePromoted.ok === true && (await foreman.snapshot()).sharedLessonCount === 1, 're-promote 供 cross-project 测试');

await projectTool.execute({ action: 'use', root: rootB }, {});
const b1 = await tool('foreman_card').execute({ id: 'B1', gates: [], acceptance: ['B1'] }, {});
assert(b1.ok === true, 'B 建卡供 shared');
const bSensitive = await archiveTool.execute({
  action: 'remember',
  cardId: 'B1',
  fingerprint: 'shared-fp-1',
  area: 'shared-area',
  symptom: `same issue in ${rootB}`,
  rootCause: 'same root',
  fix: 'same fix',
}, { agent: { id: archivistId } });
assert(bSensitive.ok === true, 'B 项目 archive 建条目');
const bPromoted = await archiveTool.execute(
  { action: 'promote', id: bSensitive.entry.id, cardId: 'B1' },
  { agent: { id: archivistId } },
);
assert(bPromoted.ok === true && bPromoted.existing === true, 'B 同 fingerprint 合并公共经验');
assert(bPromoted.lesson.seenIn.length === 2 && bPromoted.lesson.projects.length === 2, 'seenIn/projects 累计');
await projectTool.execute({ action: 'use', root }, {});
assert((await foreman.snapshot()).sharedLessonCount === 1, 'A 的 panel 仍读公共经验');
assert(foreman.brief.includes('[公共]'), 'A brief 合并公共经验');

const trapBrief = renderBrief({
  goal: 'brief',
  state: { stage: 'implement', seats: {} },
  card: { id: 'BRIEF', scope: { do: [], not: [] }, acceptance: [], gates: [] },
  evidence: [],
  challenges: [],
  archive: [1, 2, 3, 4].map((index) => ({
    id: `A${index}`, cardId: 'BRIEF', fingerprint: `fp-${index}`, status: 'open', lastSeen: index,
  })),
  findings: { p0: [], p1: [] },
  decisions: '',
});
const trapLine = trapBrief.split('\n').find((line) => line.startsWith('- 历史陷阱')) || '';
assert((trapLine.match(/A\d+/g) || []).length <= 3, 'brief 历史陷阱最多 3 条');

const repInitial = await reputationTool.execute({ action: 'status' }, {});
assert(repInitial.ok === true && Object.values(repInitial.seats).every((seat) => seat.score === 70 && seat.trust === 'normal'), '信誉初始 70 normal');
const noEvidence = await reputationTool.execute({
  action: 'award', seat: 'coder', delta: 5, reason: 'no evidence',
}, { agent: { id: hostId } });
assert(noEvidence.ok === false && /evidence/.test(noEvidence.error), '信誉调整无证据拒绝');
const noReason = await reputationTool.execute({
  action: 'penalize', seat: 'coder', delta: 5, evidence: 'A1',
}, { agent: { id: hostId } });
assert(noReason.ok === false && /reason/.test(noReason.error), '信誉调整无原因拒绝');
const archivistRead = await reputationTool.execute({ action: 'status' }, { agent: { id: archivistId } });
assert(archivistRead.ok === true, 'archivist 可读信誉');
const archivistAward = await reputationTool.execute({
  action: 'award', seat: 'coder', delta: 1, reason: 'bad', evidence: 'A1',
}, { agent: { id: archivistId } });
assert(archivistAward.ok === false && /不能修改/.test(archivistAward.error), 'archivist 不能改信誉');
const coderAward = await reputationTool.execute({
  action: 'award', seat: 'coder', delta: 1, reason: 'bad', evidence: 'A1',
}, { agent: { id: 'coder-agent-smoke' } });
assert(coderAward.ok === false, '绑定 coder 不能改信誉');
const reviewerAward = await reputationTool.execute({
  action: 'penalize', seat: 'coder', delta: 1, reason: 'no', evidence: 'A1',
}, { agent: { id: reviewerId } });
assert(reviewerAward.ok === false && /不能修改/.test(reviewerAward.error), 'reviewer 业务入口不能改信誉');
const reviewerRepList = await reputationTool.execute({ action: 'list' }, { agent: { id: reviewerId } });
assert(reviewerRepList.ok === true, 'reviewer 业务入口可读信誉 list');

const award = await reputationTool.execute({
  action: 'award', seat: 'coder', delta: 100, reason: 'great', evidence: 'A1',
}, { agent: { id: hostId } });
assert(award.ok === true && award.score === 100 && award.trust === 'high', 'award 边界 100 / high');
const penalize = await reputationTool.execute({
  action: 'penalize', seat: 'coder', delta: 200, reason: 'bad', evidence: 'A1',
}, { agent: { id: hostId } });
assert(penalize.ok === true && penalize.score === 0 && penalize.trust === 'breaker', 'penalize 边界 0 / breaker');
const restoreCoder = await reputationTool.execute({
  action: 'award', seat: 'coder', delta: 80, reason: 'restore', evidence: 'A1',
}, { agent: { id: hostId } });
assert(restoreCoder.ok === true && restoreCoder.score === 80, '信誉恢复 80');

const awardBuilder = await reputationTool.execute({
  action: 'award', seat: 'builder', delta: 15, reason: 'good build', evidence: 'E1',
}, { agent: { id: hostId } });
assert(awardBuilder.trust === 'high', '85 = high');
const watchBuilder = await reputationTool.execute({
  action: 'penalize', seat: 'builder', delta: 26, reason: 'slow', evidence: 'E1',
}, { agent: { id: hostId } });
assert(watchBuilder.score === 59 && watchBuilder.trust === 'watch', '59 = watch');
const watch40 = await reputationTool.execute({
  action: 'penalize', seat: 'builder', delta: 19, reason: 'more', evidence: 'E1',
}, { agent: { id: hostId } });
assert(watch40.score === 40 && watch40.trust === 'watch', '40 = watch');
const breaker = await reputationTool.execute({
  action: 'penalize', seat: 'builder', delta: 1, reason: 'breaker', evidence: 'E1',
}, { agent: { id: hostId } });
assert(breaker.score === 39 && breaker.trust === 'breaker', '39 = breaker');
const breakerVerdict = await tool('foreman_verdict').execute(
  { cardId: 'H1', verdict: 'ACCEPT', summary: 'low trust' },
  { agent: { id: hostId } },
);
assert(breakerVerdict.ok === false && breakerVerdict.breakers.some((item) => item.seat === 'builder'), 'breaker 阻断 ACCEPT');
const restoreBuilder = await reputationTool.execute({
  action: 'award', seat: 'builder', delta: 31, reason: 'fixed', evidence: 'E1',
}, { agent: { id: hostId } });
assert(restoreBuilder.score === 70, 'builder 恢复 70');
assert(foreman.brief.includes('信誉：') && foreman.brief.includes('builder 70 normal'), 'brief 注入信誉');
assert(foreman.brief.includes('builder 70 normal（最近 award'), 'brief 注入最近信誉事件');

const p1Card = await tool('foreman_card').execute({ id: 'P1D', gates: [], acceptance: ['p1'] }, {});
assert(p1Card.ok === true, '建 P1 去重卡');
await tool('foreman_verdict').execute(
  { cardId: 'P1D', verdict: 'RETURN', summary: 'p1 once', p1: ['same p1'] },
  { agent: { id: hostId } },
);
await tool('foreman_verdict').execute(
  { cardId: 'P1D', verdict: 'RETURN', summary: 'p1 twice', p1: ['same p1'] },
  { agent: { id: hostId } },
);
const p1State = await foreman.state();
assert(p1State.p1.filter((item) => item.cardId === 'P1D' && item.text === 'same p1').length === 1, 'P1 按 cardId+text 去重');

await tool('foreman_card').execute({ id: 'G1', setCurrent: true }, {});

const snapshot = await foreman.snapshot();
assert(snapshot.ok === true && snapshot.card.id === 'G1', '快照读到当前卡');
assert(snapshot.gateEvidenceCount >= 6 && snapshot.reportedEvidenceCount >= 1, '快照区分 gate/reported 数量');
assert(snapshot.evidence.some((entry) => entry.source === 'gate'), '快照证据列表有 source=gate');
assert(snapshot.evidence.some((entry) => entry.source === 'reported'), '快照证据列表有 source=reported');
const status = await seen.command.handler({ rawInput: 'status', agent: { id: 'session-1' } });
assert(status.kind === 'success' && /gate \d+ \/ reported \d+/.test(status.text), '/foreman status 区分 gate/reported');
assert(status.text.includes('@builder-agent-smoke'), '/foreman status 显示席位 agentId');
assert(status.text.includes('gate-smoke:exit 0'), '/foreman status 显示 gate 证据');
assert(status.text.includes(`root ${root}`) && status.text.includes(`cwd ${root}`), '/foreman status 显示 gate root/cwd');
assert(status.text.includes('五席：') && /公共经验：\d+ 条/.test(status.text), '/foreman status 五席文案 + 公共经验条数');

const frozen = await tool('foreman_card').execute({ action: 'freeze', id: 'G1', signedBy: '主持', signNote: '锁定 G1' }, {});
assert(frozen.ok === true && frozen.card.frozen === true, '冻结契约');
const sneak = await tool('foreman_card').execute({ id: 'G1', scopeDo: ['gate runner', 'shop'] }, {});
assert(sneak.ok === false && /已冻结/.test(sneak.error), '冻结后偷改范围被拒');
const signed = await tool('foreman_card').execute({ id: 'G1', scopeDo: ['gate runner', 'shop'], signedBy: '主持', signNote: '加 shop' }, {});
assert(signed.ok === true && signed.card.revise === 1, '主持签字后可改范围并升 rev');

const seat = await tool('foreman_seat').execute({ seat: 'builder', status: 'working', note: 'gate smoke' }, {});
assert(seat.ok === true && seat.agentId === 'builder-agent-smoke', '更新席位状态并返回 agentId');
const stage = await tool('foreman_stage').execute({ stage: 'review' }, {});
assert(stage.ok === true, '推进阶段');

const artifact = await tool('foreman_evidence').execute({ gate: 'build', cardId: 'G1', exitCode: 0, files: ['PROGRESS.md'] }, {});
assert(artifact.ok === true && artifact.entry.files[0].sha256.length === 16, '产物文件带 sha256');
const missingFile = await tool('foreman_evidence').execute({ gate: 'shot', cardId: 'G1', exitCode: 0, files: ['nope.png'] }, {});
assert(missingFile.ok === false && /不存在/.test(missingFile.error), '不存在的产物被拒');

assert(foreman.brief.includes('监工台 · 冒烟项目'), '简报已生成');
assert(foreman.brief.includes('gate 证据'), '简报区分 gate 证据');
assert(foreman.brief.includes('五席：'), 'brief 文案为五席');
const resume = await seen.command.handler({ rawInput: 'resume' });
assert(resume.kind === 'success' && resume.text.includes('当前任务卡'), '/foreman resume 可用');
const help = await seen.command.handler({ rawInput: 'help' });
assert(help.kind === 'success' && help.text.includes('/foreman'), '/foreman help 可用');

const projectStatus = await projectTool.execute({ action: 'status' }, {});
assert(projectStatus.ok === true && projectStatus.root === root, 'project status 显示 active root');
const aEvidenceBefore = (await foreman.snapshot()).evidenceCount;
const switchB = await projectTool.execute({ action: 'use', root: rootB }, {});
assert(switchB.ok === true && switchB.root === rootB, 'project use 切到 B');
const bEmpty = await foreman.snapshot();
assert(bEmpty.root === rootB && !bEmpty.cards.some((card) => card.id === 'G1'), 'B 无 A 卡');
const bReputation = await reputationTool.execute({ action: 'status' }, {});
assert(bReputation.seats.coder.score === 70, 'B 信誉独立（70）');
const bStatus = await seen.command.handler({ rawInput: 'status' });
assert(bStatus.kind === 'success' && bStatus.text.includes(rootB), 'status 显示 B active root');
const bCard = await tool('foreman_card').execute({ id: 'B1', gates: [], acceptance: ['B only'] }, {});
assert(bCard.ok === true && bCard.current === 'B1', 'B 建卡');
await tool('foreman_evidence').execute({ gate: 'build', cardId: 'B1', exitCode: 0, output: 'B evidence' }, {});
assert((await foreman.snapshot()).evidenceCount === 1, 'B 证据独立');

const switchA = await projectTool.execute({ action: 'use', root }, {});
assert(switchA.ok === true && switchA.root === root, 'project use 切回 A');
const aBack = await foreman.snapshot();
assert(aBack.cards.some((card) => card.id === 'G1'), 'A 卡仍在');
assert(aBack.evidenceCount === aEvidenceBefore, 'A 证据未被 B 污染');
assert(aBack.challenges.every((entry) => entry.cardId !== 'B1'), 'A challenges 未被 B 污染');
assert(aBack.root === root, 'snapshot root 回到 A');
const aReputation = await reputationTool.execute({ action: 'status' }, {});
assert(aReputation.seats.coder.score === 80, 'A 信誉保留（coder 80）');

const switchB2 = await projectTool.execute({ action: 'use', root: rootB }, {});
assert(switchB2.ok === true, '再次切 B');
const bBack = await foreman.snapshot();
assert(bBack.card && bBack.card.id === 'B1', 'B 卡/证据保留');
assert(!bBack.cards.some((card) => card.id === 'G1'), 'B 无 A 卡（切回后）');
assert(bBack.evidenceCount === 1, 'B 证据仍 1 条');

// M7.3：切到 B 后，旧项目 A 的绝对 cwd gate 被拒、不误跑；显式 allowOutsideRoot 仍可跑
const bCwdCard = await tool('foreman_card').execute({
  id: 'B3',
  gates: ['gate-cross', 'gate-outside-allow'],
  acceptance: ['B gate cwd bound to B'],
  setCurrent: false,
}, {});
assert(bCwdCard.ok === true, 'B 建 CWD 卡（不抢当前卡）');
assert((await foreman.snapshot()).card.id === 'B1', 'B CWD 卡不影响当前卡');
const bSpawnBefore = spawnLog.length;
const bEvidenceBefore = (await foreman.snapshot()).evidenceCount;
const staleCwdGate = await gateTool.execute({ gate: 'gate-cross', cardId: 'B3' }, {});
assert(staleCwdGate.ok === false && /不在当前 active root 内/.test(staleCwdGate.error), '切到 B 后旧绝对 cwd gate 被拒');
assert(staleCwdGate.root === rootB && staleCwdGate.cwd === root, '拒绝信息显示 B root + A cwd');
assert(spawnLog.length === bSpawnBefore, '切 root 后越界 gate 不 spawn');
assert((await foreman.snapshot()).evidenceCount === bEvidenceBefore, '切 root 后越界 gate 不写证据');
scenario = { exitCode: 0, stdout: 'B outside allowed', stderr: '', tamper: false, hang: false };
const bAllowed = await gateTool.execute({ gate: 'gate-outside-allow', cardId: 'B3' }, {});
assert(bAllowed.ok === true && bAllowed.entry.exitCode === 0, '显式 allowOutsideRoot 切 root 后仍可跑');
assert(bAllowed.entry.root === rootB && bAllowed.entry.cwd === outsideDir, 'B 证据记录 B root + 外部 cwd');
const bMissingGates = await foreman.missingGates('B3', bCwdCard.card);
assert(bMissingGates.includes('gate-cross'), 'missingGates 把越界 gate 判为缺失');
assert(!bMissingGates.includes('gate-outside-allow'), 'missingGates 不误伤 allowOutsideRoot gate');

const relativeReject = await projectTool.execute({ action: 'use', root: 'relative-project' }, {});
assert(relativeReject.ok === false && /绝对路径/.test(relativeReject.error), '相对 root 被拒');
const missingReject = await projectTool.execute({ action: 'use', root: join(rootB, 'nope') }, {});
assert(missingReject.ok === false && /不存在/.test(missingReject.error), '不存在 root 被拒');
const fileReject = await projectTool.execute({ action: 'use', root: join(rootB, 'PROGRESS.md') }, {});
assert(fileReject.ok === false && /不是目录/.test(fileReject.error), '文件 root 被拒');
assert((await foreman.snapshot()).root === rootB, '拒绝后 active root 不变');

const finalA = await projectTool.execute({ action: 'use', root }, {});
assert(finalA.ok === true && (await foreman.snapshot()).card.id === 'G1', '最终切回 A 当前卡');

const agentA = 'fake-agent-a';
const agentB = 'fake-agent-b';
const execA = { agent: { id: agentA } };
const execB = { agent: { id: agentB } };
const [switchAgentA, switchAgentB] = await Promise.all([
  projectTool.execute({ action: 'use', root }, execA),
  projectTool.execute({ action: 'use', root: rootB }, execB),
]);
assert(switchAgentA.ok === true && switchAgentB.ok === true, '两个 fake agent 并发切 root');
const agentAStatus = await tool('foreman_status').execute({}, execA);
const agentBStatus = await tool('foreman_status').execute({}, execB);
assert(agentAStatus.summary.includes(root) && !agentAStatus.summary.includes(rootB), 'agent A 状态只读 A root');
assert(agentBStatus.summary.includes(rootB), 'agent B 状态只读 B root');
const agentACard = await tool('foreman_card').execute(
  { id: 'A2', gates: [], acceptance: ['A only'] },
  execA,
);
const globalBriefBeforeB = foreman.globalBrief;
const sectionBeforeB = seen.section.text();
const agentBCard = await tool('foreman_card').execute(
  { id: 'B2', gates: [], acceptance: ['B only'] },
  execB,
);
assert(agentACard.ok === true && agentBCard.ok === true, 'A/B 各自建卡');
assert(foreman.globalBrief === globalBriefBeforeB && seen.section.text() === sectionBeforeB, 'B 操作不覆盖全局 default brief');
assert(foreman.brief.includes('B2'), 'B active root 自己的 brief 仍生成');
const aCardStatus = await tool('foreman_status').execute({}, execA);
const bCardStatus = await tool('foreman_status').execute({}, execB);
assert(aCardStatus.summary.includes('A2') && !aCardStatus.summary.includes('B2'), 'A 当前卡/B 数据不交叉');
assert(bCardStatus.summary.includes('B2') && !bCardStatus.summary.includes('A2'), 'B 当前卡/A 数据不交叉');

const agentASwitchB = await projectTool.execute({ action: 'use', root: rootB }, execA);
assert(agentASwitchB.ok === true, 'agent A 可单独切到 B');
const aAfterSwitchB = await projectTool.execute({ action: 'status' }, execA);
const bAfterASwitch = await projectTool.execute({ action: 'status' }, execB);
const defaultAfterASwitch = await tool('foreman_status').execute({}, {});
assert(aAfterSwitchB.root === rootB && bAfterASwitch.root === rootB, 'A 切换只影响 A');
assert(defaultAfterASwitch.summary.includes(`active root：${root}`), '无标识回退 default root');
await projectTool.execute({ action: 'use', root }, execA);

const panelSnapshot = await foreman.snapshot();
assert(panelSnapshot.root === root, 'panel 使用 last active root');

// M7：新会话重绑、旧 id 失效、挑战恢复、waive、ACL 切换
const unboundSnapshot = await foreman.snapshot();
assert(Boolean(unboundSnapshot.bindingWarning), '新会话未绑定时明确提示');
const oldOpen = await challengeTool.execute(
  { action: 'open', cardId: 'G1' },
  { agent: { id: reviewerId } },
);
assert(oldOpen.ok === true && oldOpen.challenge.assignedSeat === 'nitpicker', '挑战存 assignedSeat=nitpicker');
const oldBindAttempt = await tool('foreman_seat').execute(
  { action: 'bind', seat: 'reviewer', agentId: 'new-reviewer' },
  { agent: { id: reviewerId } },
);
assert(oldBindAttempt.ok === false && /只有主持/.test(oldBindAttempt.error), '已绑定 agent 不能 bind');

const newIds = {
  coder: 'new-coder-agent',
  reviewer: 'new-reviewer-agent',
  builder: 'new-builder-agent',
  nitpicker: 'new-nitpicker-agent',
  archivist: 'new-archivist-agent',
};
const newHost = 'new-session-host';
for (const [seat, agentId] of Object.entries(newIds)) seen.agents.push(fakeAgent(agentId));
const firstBind = await tool('foreman_seat').execute(
  { action: 'bind', seat: 'nitpicker', agentId: newIds.nitpicker },
  { agent: { id: newHost } },
);
assert(firstBind.ok === true, '只 bind nitpicker');
const singleBindSnapshot = await foreman.snapshot();
assert(singleBindSnapshot.bindingWarning && singleBindSnapshot.unboundSeats.includes('coder'), '只 bind 一席仍显示未绑定');
for (const [seat, agentId] of Object.entries(newIds)) {
  if (seat === 'nitpicker') continue;
  const bound = await tool('foreman_seat').execute(
    { action: 'bind', seat, agentId },
    { agent: { id: newHost } },
  );
  assert(bound.ok === true && bound.agentId === agentId, `新会话 bind ${seat}`);
}
const newHostStatus = await tool('foreman_status').execute({}, { agent: { id: newHost } });
assert(!newHostStatus.summary.includes('当前会话未绑定') && !newHostStatus.summary.includes('绑定不完整'), '五席 bind 后当前会话无未绑定提示');
const childStatus = await tool('foreman_status').execute({}, { agent: { id: newIds.reviewer } });
assert(!childStatus.summary.includes('当前会话未绑定') && !childStatus.summary.includes('绑定不完整'), '子会话与父会话 bound 视图一致');
const oldHostStatus = await tool('foreman_status').execute({}, { agent: { id: 'old-session-host' } });
assert(/rebind-required|当前会话未绑定/.test(oldHostStatus.summary), '旧会话看到 rebind-required/未绑定提示');
const oldSeatStatus = await tool('foreman_status').execute({}, { agent: { id: reviewerId } });
assert(/rebind-required|当前会话未绑定/.test(oldSeatStatus.summary), '旧 retired id 不算 bound');

const oldResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'G1', decision: 'cleared' },
  { agent: { id: nitpickerId } },
);
assert(oldResolve.ok === false && /失效/.test(oldResolve.error), '旧 Nitpicker id 不能 resolve');
const newResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'G1', decision: 'cleared' },
  { agent: { id: newIds.nitpicker } },
);
assert(newResolve.ok === true && newResolve.challenge.status === 'cleared', '新会话 Nitpicker resolve 旧挑战');
assert(denied('write', newIds.reviewer) && denied('write', reviewerId), '新 reviewer 受限且旧 id 被拒');
assert(!denied('write', newIds.coder), '新 coder 保留 write');
const newReviewerFilter = seen.filters.filter((entry) => entry.agentId === newIds.reviewer).at(-1)?.filter;
assert(newReviewerFilter && newReviewerFilter.allow && !newReviewerFilter.allow.includes('write'), 'bind 后新 reviewer 安装 schema filter');

const newAccept = await tool('foreman_verdict').execute(
  { cardId: 'G1', verdict: 'ACCEPT', summary: 'new session review' },
  { agent: { id: newIds.reviewer } },
);
assert(newAccept.ok === true, '新会话 resolve 后可 ACCEPT');

const waiveOpen = await challengeTool.execute(
  { action: 'open', cardId: 'G1' },
  { agent: { id: newIds.reviewer } },
);
assert(waiveOpen.ok === true, '开挑战供 waive');
const waiveMissing = await challengeTool.execute(
  { action: 'waive', cardId: 'G1' },
  { agent: { id: newHost } },
);
assert(waiveMissing.ok === false && /reason/.test(waiveMissing.error), 'waive 无 reason 拒绝');
const waived = await challengeTool.execute(
  { action: 'waive', cardId: 'G1', reason: '已知可接受风险', evidence: 'decision:M7' },
  { agent: { id: newHost } },
);
assert(waived.ok === true && waived.challenge.status === 'waived', '主持 waive 写 waived');
const waivedAccept = await tool('foreman_verdict').execute(
  { cardId: 'G1', verdict: 'ACCEPT', summary: 'waived challenge' },
  { agent: { id: newIds.reviewer } },
);
assert(waivedAccept.ok === true, 'ACCEPT 接受 waived');
const oldAfter = await tool('foreman_seat').execute(
  { action: 'bind', seat: 'reviewer', agentId: 'x' },
  { agent: { id: nitpickerId } },
);
assert(oldAfter.ok === false, '旧 nitpicker 也失去 bind 权限');

const reloaded = new Foreman(ctx, {
  root,
  goal: '冒烟项目',
  gates: gateConfig,
  roster: rosterConfig,
  gateGraceMs: 20,
  sharedLessonsPath: sharedFile,
});
await reloaded.ensureReady();
const reloadedSnapshot = await reloaded.snapshot();
assert(reloadedSnapshot.rebindRequired === true && /rebind-required/.test(reloadedSnapshot.bindingWarning), '重启 session mismatch → rebind-required');
assert(reloadedSnapshot.unboundSeats.length === 5, 'rebind-required 列出五席缺失');
assert(reloaded.roster.find((seat) => seat.id === 'reviewer').agentId === newIds.reviewer, '持久化绑定不被 config 旧 id 覆盖');
assert(reloaded.seatForAgent(newIds.reviewer).id === 'reviewer', '重载后新 reviewer 被识别');
assert(reloaded.seatForAgent(reviewerId).id === 'retired', '重载后旧 reviewer 仍 retired');
const bindingsDisk = await readFile(join(root, '.foreman', 'bindings.json'), 'utf8');
assert(bindingsDisk.includes(newIds.reviewer) && bindingsDisk.includes(reviewerId), 'bindings.json 持久化新绑定与 retired');

const reboundHost = 'rebound-session-host';
const reboundIds = {
  coder: 'rebound-coder',
  reviewer: 'rebound-reviewer',
  builder: 'rebound-builder',
  nitpicker: 'rebound-nitpicker',
  archivist: 'rebound-archivist',
};
for (const id of Object.values(reboundIds)) seen.agents.push(fakeAgent(id));
const missingRebind = { ...reboundIds };
delete missingRebind.coder;
const missingResult = await tool('foreman_seat').execute(
  { action: 'rebind', agents: missingRebind },
  { agent: { id: reboundHost } },
);
assert(missingResult.ok === false && /missing/.test(missingResult.error), 'rebind 缺席拒绝');
const duplicateResult = await tool('foreman_seat').execute(
  { action: 'rebind', agents: { ...reboundIds, coder: reboundIds.reviewer } },
  { agent: { id: reboundHost } },
);
assert(duplicateResult.ok === false && /唯一/.test(duplicateResult.error), 'rebind 重复 id 拒绝');
const retiredResult = await tool('foreman_seat').execute(
  { action: 'rebind', agents: { ...reboundIds, coder: reviewerId } },
  { agent: { id: reboundHost } },
);
assert(retiredResult.ok === false && /retired/.test(retiredResult.error), 'rebind 使用旧 id 拒绝');
const boundCallerRebind = await tool('foreman_seat').execute(
  { action: 'rebind', agents: reboundIds },
  { agent: { id: newIds.reviewer } },
);
assert(boundCallerRebind.ok === false, '已绑定 agent 不能 rebind');
const rebindResult = await tool('foreman_seat').execute(
  { action: 'rebind', agents: reboundIds },
  { agent: { id: reboundHost } },
);
assert(rebindResult.ok === true && rebindResult.bindingWarning === '', '五席 rebind 原子成功并清 warning');
const reboundStatus = await tool('foreman_status').execute({}, { agent: { id: reboundHost } });
assert(!reboundStatus.summary.includes('rebind-required') && !reboundStatus.summary.includes('绑定不完整'), 'rebind 后当前会话 bound');
const reboundSnapshot = await foreman.snapshot();
assert(reboundSnapshot.rebindRequired === false && reboundSnapshot.unboundSeats.length === 0, 'rebind 后快照五席 bound');
assert(foreman.seatForAgent(newIds.reviewer).id === 'retired' && foreman.seatForAgent(reviewerId).id === 'retired', 'rebind 后旧 id retired');
assert(foreman.seatForAgent(reboundIds.reviewer).id === 'reviewer' && denied('write', reboundIds.reviewer), 'rebind 后新 reviewer ACL');

const reloaded2 = new Foreman(ctx, {
  root,
  goal: '冒烟项目',
  gates: gateConfig,
  roster: rosterConfig,
  gateGraceMs: 20,
  sharedLessonsPath: sharedFile,
});
await reloaded2.ensureReady();
const reboundReloadSnapshot = await reloaded2.withRoot(
  { agent: { id: reboundHost } },
  () => reloaded2.snapshot(),
);
assert(!reboundReloadSnapshot.rebindRequired && !reboundReloadSnapshot.bindingWarning, '重载后同 host session 五席 bound');
const childReloadSnapshot = await reloaded2.withRoot(
  { agent: { id: reboundIds.reviewer } },
  () => reloaded2.snapshot(),
);
assert(!childReloadSnapshot.rebindRequired && !childReloadSnapshot.bindingWarning, '重载后子会话 bound 视图一致');

const reboundChallenge = await challengeTool.execute(
  { action: 'open', cardId: 'G1' },
  { agent: { id: reboundIds.reviewer } },
);
assert(reboundChallenge.ok === true, 'rebind 后开挑战');
const oldReboundResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'G1', decision: 'cleared' },
  { agent: { id: newIds.nitpicker } },
);
assert(oldReboundResolve.ok === false && /失效/.test(oldReboundResolve.error), 'rebind 后旧 nitpicker 不能 resolve');
const newReboundResolve = await challengeTool.execute(
  { action: 'resolve', cardId: 'G1', decision: 'cleared' },
  { agent: { id: reboundIds.nitpicker } },
);
assert(newReboundResolve.ok === true && newReboundResolve.challenge.status === 'cleared', 'rebind 后新 nitpicker resolve');
const reboundAccept = await tool('foreman_verdict').execute(
  { cardId: 'G1', verdict: 'ACCEPT', summary: 'rebind session' },
  { agent: { id: reboundIds.reviewer } },
);
assert(reboundAccept.ok === true, 'rebind 后 ACL/挑战走新 roster 并 ACCEPT');

// M7.6：seat 自注册 claim（agentId 只取 exec.agent.id）
const claimTool = tool('foreman_seat');
assert(claimTool.parameters.properties.action.enum.includes('claim'), 'foreman_seat schema 含 action=claim');
assert(/claim/.test(claimTool.parameters.properties.agentId.description), 'claim 的 agentId 说明只认调用者');
seen.agents.length = 0; // 模拟重启：上一轮 rebound agent 不再存活
const claimIds = {
  coder: 'claim-coder-agent',
  reviewer: 'claim-reviewer-agent',
  builder: 'claim-builder-agent',
  nitpicker: 'claim-nitpicker-agent',
  archivist: 'claim-archivist-agent',
};
const claimAgents = {};
for (const id of Object.values(claimIds)) {
  claimAgents[id] = fakeAgent(id);
  seen.agents.push(claimAgents[id]);
}

const claimNoCaller = await claimTool.execute({ action: 'claim', seat: 'coder' }, {});
assert(claimNoCaller.ok === false && /exec\.agent/.test(claimNoCaller.error), 'claim 无调用者 agent 拒绝（不能自报）');
const claimRetired = await claimTool.execute(
  { action: 'claim', seat: 'coder' },
  { agent: { id: newIds.reviewer } },
);
assert(claimRetired.ok === false && /retired/.test(claimRetired.error), 'retired 会话 claim 拒绝');
const claimUnknown = await claimTool.execute(
  { action: 'claim', seat: 'wizard' },
  { agent: { id: claimIds.coder } },
);
assert(claimUnknown.ok === false && /未知席位/.test(claimUnknown.error), '未知 seat claim 拒绝');
const preClaimStatus = await tool('foreman_status').execute({}, { agent: { id: 'pre-claim-host' } });
assert(/rebind-required/.test(preClaimStatus.summary), 'claim 前新会话看到 rebind-required');

const liveOldNitpicker = fakeAgent(reboundIds.nitpicker);
seen.agents.push(liveOldNitpicker);
const claimLiveSeat = await claimTool.execute(
  { action: 'claim', seat: 'nitpicker' },
  { agent: { id: claimIds.nitpicker } },
);
assert(claimLiveSeat.ok === false && /存活/.test(claimLiveSeat.error), 'seat 绑给存活 agent 时 claim 拒绝');
seen.agents.splice(seen.agents.indexOf(liveOldNitpicker), 1);

const coderClaim = await claimTool.execute(
  { action: 'claim', seat: 'coder' },
  { agent: { id: claimIds.coder } },
);
assert(
  coderClaim.ok === true && coderClaim.agentId === claimIds.coder && coderClaim.claimedSeats.includes('coder'),
  'coder claim 成功且 agentId 取自调用者',
);
const repeatClaim = await claimTool.execute(
  { action: 'claim', seat: 'coder' },
  { agent: { id: claimIds.coder } },
);
assert(repeatClaim.ok === false && /重复/.test(repeatClaim.error), '同一 seat 重复 claim 拒绝');
const crossSeatClaim = await claimTool.execute(
  { action: 'claim', seat: 'reviewer' },
  { agent: { id: claimIds.coder } },
);
assert(crossSeatClaim.ok === false && /已占用席位|只允许席位自己/.test(crossSeatClaim.error), '同一 agent 不能跨 seat claim');
const stealClaim = await claimTool.execute(
  { action: 'claim', seat: 'coder' },
  { agent: { id: 'other-live-claim-agent' } },
);
assert(stealClaim.ok === false && /存活/.test(stealClaim.error), '另一 agent 不能抢已 claim 的 seat');

const partialClaimSnapshot = await foreman.snapshot();
assert(
  partialClaimSnapshot.bindingWarning.includes('reviewer')
  && partialClaimSnapshot.unboundSeats.includes('reviewer')
  && !partialClaimSnapshot.unboundSeats.includes('coder'),
  'claim 一席后 warning 仍列出缺失 claim 的 seat',
);
assert(partialClaimSnapshot.claimedSeats.includes('coder'), '快照显示已 claim 的 seat');

const builderClaim = await claimTool.execute(
  { action: 'claim', seat: 'builder' },
  { agent: { id: claimIds.builder } },
);
const reviewerClaim = await claimTool.execute(
  { action: 'claim', seat: 'reviewer' },
  { agent: { id: claimIds.reviewer } },
);
assert(builderClaim.ok === true && reviewerClaim.ok === true, 'builder/reviewer claim 成功');
const forgedClaim = await claimTool.execute(
  { action: 'claim', seat: 'archivist', agentId: 'forged-archivist-id' },
  { agent: { id: claimIds.archivist } },
);
assert(forgedClaim.ok === true && forgedClaim.agentId === claimIds.archivist, 'claim 忽略自报 agentId，只用调用者 id');
assert(foreman.roster.find((seat) => seat.id === 'archivist').agentId === claimIds.archivist, 'roster 落调用者 agentId');
assert(!JSON.stringify([...foreman.bindingsForRoot().values()]).includes('forged-archivist-id'), '自报 agentId 未写入 bindings');

const nitpickerClaim = await claimTool.execute(
  { action: 'claim', seat: 'nitpicker' },
  { agent: { id: claimIds.nitpicker } },
);
assert(nitpickerClaim.ok === true && nitpickerClaim.allSeatsClaimed === true, '五席 claim 齐');
assert(nitpickerClaim.bindingWarning === '' && nitpickerClaim.rebindRequired === false, '五席 claim 齐后自动 bound、清 rebind-required');

const claimSnapshot = await foreman.snapshot();
assert(claimSnapshot.allSeatsClaimed === true && claimSnapshot.claimedSeats.length === 5, '快照五席已 claim');
assert(
  claimSnapshot.unboundSeats.length === 0
  && claimSnapshot.unclaimedSeats.length === 0
  && claimSnapshot.bindingWarning === '',
  'claim 齐后快照无未绑定警告',
);
const postClaimHostStatus = await tool('foreman_status').execute({}, { agent: { id: 'post-claim-host' } });
assert(
  !postClaimHostStatus.summary.includes('rebind-required') && !postClaimHostStatus.summary.includes('绑定不完整'),
  '五席 claim 后 host status 不再警告',
);
assert(foreman.brief.includes('已绑定五席'), 'brief 显示已绑定五席');

assert(
  denied('write', claimIds.reviewer) && denied('write', claimIds.nitpicker) && denied('write', claimIds.builder),
  'claim 后 reviewer/nitpicker/builder ACL 生效',
);
assert(!denied('write', claimIds.coder), 'claim 后 coder 保留 write');
assert(
  denied('foreman_verdict', claimIds.coder) && denied('foreman_stage', claimIds.coder),
  'claim 后 coder 拒 verdict/stage',
);
// M7.12：五席 claim 后 + tools:change 后的 live schema 矩阵
const visibleNamesOf = (agent) => agent.ctx.tools.schemas().map((schema) => schema.name);
const assertFiveSeatSchemaMatrix = (label) => {
  const coder = visibleNamesOf(claimAgents[claimIds.coder]);
  const builder = visibleNamesOf(claimAgents[claimIds.builder]);
  const reviewer = visibleNamesOf(claimAgents[claimIds.reviewer]);
  const nitpicker = visibleNamesOf(claimAgents[claimIds.nitpicker]);
  const archivist = visibleNamesOf(claimAgents[claimIds.archivist]);
  assert(!coder.includes('foreman_verdict') && !coder.includes('foreman_stage'), `${label} coder schema 无 verdict/stage`);
  assert(coder.includes('write'), `${label} coder 保留 write`);
  assert(
    !builder.includes('write') && !builder.includes('edit') && !builder.includes('str_replace_editor'),
    `${label} builder schema 无 write/edit/str_replace_editor`,
  );
  assert(builder.includes('pwsh'), `${label} builder 保留 pwsh`);
  assert(
    !reviewer.includes('write') && !reviewer.includes('pwsh')
    && !nitpicker.includes('write') && !nitpicker.includes('pwsh')
    && !archivist.includes('write') && !archivist.includes('pwsh'),
    `${label} reviewer/nitpicker/archivist schema 无 write/pwsh`,
  );
};
assertFiveSeatSchemaMatrix('M7.12 claim 后');
const claimReviewerFilter = seen.filters.filter((entry) => entry.agentId === claimIds.reviewer).at(-1)?.filter;
assert(
  claimReviewerFilter && claimReviewerFilter.allow && !claimReviewerFilter.allow.includes('write'),
  'claim 后 reviewer schema filter 立即安装',
);
const claimCoderScoped = seen.scopedTools.filter((entry) => entry.agentId === claimIds.coder).at(-1);
assert(
  claimCoderScoped && claimCoderScoped.definition.parameters.properties.action.enum.join(',') === 'open,list',
  'claim 后 coder challenge schema 立即安装',
);
// M7.9：claim 后隔一轮 tools/change，coder schema 仍不能出现 verdict/stage
seen.toolsChange();
const coderVisibleAfterRound = claimAgents[claimIds.coder].ctx.tools.schemas().map((schema) => schema.name);
assert(
  !coderVisibleAfterRound.includes('foreman_verdict') && !coderVisibleAfterRound.includes('foreman_stage'),
  'claim+tools:change 后 coder schema 无 verdict/stage',
);
const coderFilterAfterRound = seen.filters.filter((entry) => entry.agentId === claimIds.coder).at(-1)?.filter;
assert(
  coderFilterAfterRound && Array.isArray(coderFilterAfterRound.deny)
  && coderFilterAfterRound.deny.includes('foreman_verdict')
  && coderFilterAfterRound.deny.includes('foreman_stage'),
  'claim 后隔一轮 coder deny filter 仍在',
);
assertFiveSeatSchemaMatrix('M7.12 tools:change 后');
assert(
  foreman.seatForAgent(reboundIds.coder).id === 'retired'
  && foreman.seatForAgent(reboundIds.nitpicker).id === 'retired',
  '被 claim 替换的旧 id 进 retired',
);

const claimBindingsDisk = JSON.parse(await readFile(join(root, '.foreman', 'bindings.json'), 'utf8'));
assert(
  claimBindingsDisk.seatBindings.coder.claim === true
  && claimBindingsDisk.seatBindings.coder.session === foreman.bindingEpoch,
  'bindings.json 落 claim/epoch',
);
assert(
  claimBindingsDisk.seatBindings.nitpicker.agentId === claimIds.nitpicker
  && claimBindingsDisk.retired.includes(reboundIds.coder),
  'bindings.json 落新 id 与 retired',
);
const claimRosterDisk = JSON.parse(await readFile(join(root, '.foreman', 'roster.json'), 'utf8'));
assert(claimRosterDisk.find((seat) => seat.id === 'reviewer').agentId === claimIds.reviewer, 'claim 写 roster.json');
const claimStateDisk = JSON.parse(await readFile(join(root, '.foreman', 'state.json'), 'utf8'));
assert(claimStateDisk.seats.coder.agentId === claimIds.coder, 'claim 写 state.json');

const reloadedClaim = new Foreman(ctx, {
  root,
  goal: '冒烟项目',
  gates: gateConfig,
  roster: rosterConfig,
  gateGraceMs: 20,
  sharedLessonsPath: sharedFile,
});
await reloadedClaim.ensureReady();
const reloadedClaimSnapshot = await reloadedClaim.snapshot();
assert(
  reloadedClaimSnapshot.rebindRequired === true && /rebind-required/.test(reloadedClaimSnapshot.bindingWarning),
  '重载后旧 claim 失效 → rebind-required',
);
assert(reloadedClaimSnapshot.unboundSeats.length === 5, '重载后五席需重新 claim');

// M7.10：claim 顺序无关 + 旧 epoch/retired 判定 + warning 不漏报（E2E P1 回归）
const rootClaimOrderA = resolve(join(tmpdir(), `foreman-m2-smoke-claim-a-${process.pid}-${Date.now()}`));
const rootClaimOrderB = resolve(join(tmpdir(), `foreman-m2-smoke-claim-b-${process.pid}-${Date.now()}`));
for (const targetRoot of [rootClaimOrderA, rootClaimOrderB]) {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
}
const newClaimForeman = (targetRoot) => new Foreman(ctx, {
  root: targetRoot,
  goal: 'claim-order',
  gates: {},
  roster: rosterConfig,
  gateGraceMs: 20,
  sharedLessonsPath: sharedFile,
});
const claimAsSeat = (target, seatId, agentId) => target.withRoot(
  { agent: { id: agentId } },
  () => target.setSeat({ action: 'claim', seat: seatId }, { agent: { id: agentId } }),
);
const snapshotAs = (target, agentId) => target.withRoot(
  { agent: { id: agentId } },
  () => target.snapshot(),
);
const statusAs = (target, agentId) => target.withRoot(
  { agent: { id: agentId } },
  () => target.statusText(),
);

// A：旧进程只 claim coder 后重启；旧 claim 的 session/epoch 失效（不改 retired，避免掩盖问题）。
const oldPartial = newClaimForeman(rootClaimOrderA);
await oldPartial.ensureReady();
assert((await claimAsSeat(oldPartial, 'coder', 'old-partial-coder')).ok === true, 'M7.10 旧进程先 claim coder');
const freshPartial = newClaimForeman(rootClaimOrderA);
await freshPartial.ensureReady();
const freshPartialSnap = await snapshotAs(freshPartial, 'fresh-partial-host');
assert(
  freshPartialSnap.rebindRequired === true
  && freshPartialSnap.unboundSeats.includes('coder')
  && /rebind-required/.test(freshPartialSnap.bindingWarning)
  && freshPartialSnap.bindingWarning.includes('coder'),
  'M7.10 部分旧 claim 重启后 coder 进入缺失列表（不因部分绑定漏报）',
);
const freshPartialStatus = await statusAs(freshPartial, 'fresh-partial-host');
assert(
  freshPartialStatus.includes('绑定：rebind-required') && freshPartialStatus.includes('coder'),
  'M7.10 status 始终有绑定行，rebind-required 列出 coder',
);
const coderFirst = await claimAsSeat(freshPartial, 'coder', 'fresh-partial-coder');
assert(
  coderFirst.ok === true && coderFirst.claimedSeats.includes('coder'),
  'M7.10 全新会话第一席先 claim coder 成功',
);
assert(freshPartial.seatForAgent('old-partial-coder').id === 'retired', 'M7.10 旧 claim 被替换后进 retired');
const retiredClaim = await claimAsSeat(freshPartial, 'reviewer', 'old-partial-coder');
assert(retiredClaim.ok === false && /retired|失效/.test(retiredClaim.error), 'M7.10 retired 旧 id 不能 claim 新席位');
const afterCoderSnap = await snapshotAs(freshPartial, 'fresh-partial-host');
assert(
  !afterCoderSnap.unboundSeats.includes('coder')
  && !afterCoderSnap.bindingWarning.includes('coder')
  && afterCoderSnap.bindingWarning.includes('reviewer'),
  'M7.10 coder claim 后 warning 只列剩余席位',
);
const afterCoderStatus = await statusAs(freshPartial, 'fresh-partial-host');
assert(
  afterCoderStatus.includes('绑定：绑定不完整') && afterCoderStatus.includes('reviewer'),
  'M7.10 status 缺失态显示绑定不完整并列出剩余席位',
);
for (const seatId of ['nitpicker', 'builder', 'archivist', 'reviewer']) {
  assert(
    (await claimAsSeat(freshPartial, seatId, `fresh-partial-${seatId}`)).ok === true,
    `M7.10 任意顺序 claim ${seatId} 成功`,
  );
}
const partialBoundSnap = await snapshotAs(freshPartial, 'fresh-partial-host');
assert(
  partialBoundSnap.allSeatsClaimed === true
  && partialBoundSnap.rebindRequired === false
  && partialBoundSnap.unboundSeats.length === 0
  && partialBoundSnap.bindingWarning === '',
  'M7.10 部分旧 claim 场景五席齐后 bound、warning 清空',
);
const partialBoundStatus = await statusAs(freshPartial, 'fresh-partial-host');
assert(
  partialBoundStatus.includes('绑定：已绑定五席')
  && !partialBoundStatus.includes('rebind-required')
  && !partialBoundStatus.includes('绑定不完整'),
  'M7.10 五席齐后 status 绑定行显示已绑定',
);

// B：旧进程五席 claim 齐后重启；新会话 archivist 起手，coder 最后。
const oldFull = newClaimForeman(rootClaimOrderB);
await oldFull.ensureReady();
for (const seatId of ['coder', 'reviewer', 'builder', 'nitpicker', 'archivist']) {
  assert(
    (await claimAsSeat(oldFull, seatId, `old-full-${seatId}`)).ok === true,
    `M7.10 旧进程 claim ${seatId}`,
  );
}
const freshFull = newClaimForeman(rootClaimOrderB);
await freshFull.ensureReady();
// 旧 epoch 的 coder 仍在宿主里“存活”：它已经失效，不能阻断新会话 coder 后手 claim。
const stillLiveOldCoder = fakeAgent('old-full-coder');
seen.agents.push(stillLiveOldCoder);
const freshFullBefore = await snapshotAs(freshFull, 'fresh-full-host');
assert(
  freshFullBefore.rebindRequired === true
  && ['coder', 'reviewer', 'builder', 'nitpicker', 'archivist']
    .every((seatId) => freshFullBefore.unboundSeats.includes(seatId))
  && freshFullBefore.bindingWarning.includes('coder'),
  'M7.10 全量旧 claim 重启后五席缺失（含 coder）',
);
const firstArchivist = await claimAsSeat(freshFull, 'archivist', 'fresh-full-archivist');
assert(firstArchivist.ok === true, 'M7.10 第一席不必是 coder（archivist 起手成功）');
const afterArchivist = await snapshotAs(freshFull, 'fresh-full-host');
assert(
  afterArchivist.unboundSeats.includes('coder')
  && afterArchivist.bindingWarning.includes('coder')
  && !afterArchivist.unboundSeats.includes('archivist'),
  'M7.10 archivist 起手后未 claim 的 coder 仍在 warning',
);
for (const seatId of ['reviewer', 'builder', 'nitpicker', 'coder']) {
  assert(
    (await claimAsSeat(freshFull, seatId, `fresh-full-${seatId}`)).ok === true,
    `M7.10 coder 不先手时 claim ${seatId} 成功`,
  );
}
const fullBoundSnap = await snapshotAs(freshFull, 'fresh-full-host');
assert(
  fullBoundSnap.allSeatsClaimed === true
  && fullBoundSnap.rebindRequired === false
  && fullBoundSnap.bindingWarning === ''
  && fullBoundSnap.claimedSeats.length === 5,
  'M7.10 全量旧 claim 场景五席齐后 bound',
);
assert(
  freshFull.seatForAgent('old-full-coder').id === 'retired'
  && freshFull.seatForAgent('old-full-archivist').id === 'retired'
  && freshFull.seatForAgent('fresh-full-coder').id === 'coder',
  'M7.10 旧 id 全部 retired，新 id 正确映射席位',
);
assert(
  fullBoundSnap.claimedSeats.includes('coder')
  && freshFull.seatForAgent('fresh-full-coder').id === 'coder',
  'M7.10 旧 epoch 存活 agent 不阻断 coder 后手接管',
);
seen.agents.splice(seen.agents.indexOf(stillLiveOldCoder), 1);

// C：旧 host 用 bind 绑满五席后重启（项目面板常见的 rebind-required 形态），先 claim coder。
const rootClaimOrderC = resolve(join(tmpdir(), `foreman-m2-smoke-claim-c-${process.pid}-${Date.now()}`));
await rm(rootClaimOrderC, { recursive: true, force: true });
await mkdir(rootClaimOrderC, { recursive: true });
const oldBindHost = newClaimForeman(rootClaimOrderC);
await oldBindHost.ensureReady();
for (const seatId of ['coder', 'reviewer', 'builder', 'nitpicker', 'archivist']) {
  const bindResult = await oldBindHost.withRoot(
    { agent: { id: 'old-bind-host' } },
    () => oldBindHost.setSeat(
      { action: 'bind', seat: seatId, agentId: `old-bind-${seatId}` },
      { agent: { id: 'old-bind-host' } },
    ),
  );
  assert(bindResult.ok === true, `M7.10 旧 host bind ${seatId}`);
}
const freshHostBind = newClaimForeman(rootClaimOrderC);
await freshHostBind.ensureReady();
const freshBindBefore = await snapshotAs(freshHostBind, 'fresh-bind-host');
assert(
  freshBindBefore.rebindRequired === true
  && freshBindBefore.bindingWarning.includes('coder')
  && freshBindBefore.bindingWarning.includes('rebind-required'),
  'M7.10 完整 host bind 重启后 rebind-required 且 coder 在缺失列表',
);
const firstCoderBind = await claimAsSeat(freshHostBind, 'coder', 'fresh-bind-coder');
assert(firstCoderBind.ok === true, 'M7.10 完整 host bind 重启后第一席先 claim coder 成功');
for (const seatId of ['archivist', 'reviewer', 'builder', 'nitpicker']) {
  assert(
    (await claimAsSeat(freshHostBind, seatId, `fresh-bind-${seatId}`)).ok === true,
    `M7.10 host bind 重启后任意顺序 claim ${seatId} 成功`,
  );
}
const hostBindDone = await snapshotAs(freshHostBind, 'fresh-bind-host');
assert(
  hostBindDone.allSeatsClaimed === true
  && hostBindDone.rebindRequired === false
  && hostBindDone.bindingWarning === '',
  'M7.10 host bind 重启后五席换 claim，bound 且 warning 清空',
);

// M7.12：live-like Builder——DSH 默认 profile 没有 str_replace_editor，restrict 不能因未知工具整条失败。
const rootLiveBuilder = resolve(join(tmpdir(), `foreman-m2-smoke-live-builder-${process.pid}-${Date.now()}`));
await rm(rootLiveBuilder, { recursive: true, force: true });
await mkdir(rootLiveBuilder, { recursive: true });
const liveKnownToolNames = [
  ...seen.tools.map((tool) => tool.name),
  ...seen.lateTools,
  'read', 'grep', 'glob', 'read_image', 'write', 'edit', 'pwsh', 'bash', 'terminal',
  'job_output', 'job_kill', 'create_goal',
];
const liveBuilderAgent = fakeAgent('m712-live-builder', {
  knownTools: liveKnownToolNames,
  schemas: (base, filter) => {
    const all = base.filter((tool) => tool.name !== 'str_replace_editor');
    if (!filter) return all;
    if (Array.isArray(filter.allow)) return all.filter((tool) => filter.allow.includes(tool.name));
    if (Array.isArray(filter.deny)) return all.filter((tool) => !filter.deny.includes(tool.name));
    return all;
  },
});
const liveBuilderForeman = new Foreman(ctx, {
  root: rootLiveBuilder,
  goal: 'live-builder-schema',
  gates: {},
  roster: rosterConfig,
  gateGraceMs: 20,
  sharedLessonsPath: sharedFile,
});
await liveBuilderForeman.ensureReady();
seen.agents.push(liveBuilderAgent);
const liveBuilderClaim = await liveBuilderForeman.withRoot(
  { agent: { id: liveBuilderAgent.id } },
  () => liveBuilderForeman.setSeat(
    { action: 'claim', seat: 'builder' },
    { agent: { id: liveBuilderAgent.id } },
  ),
);
assert(liveBuilderClaim.ok === true, 'M7.12 live-like builder claim 成功');
assert(liveBuilderClaim.policyInstalled === true && !liveBuilderClaim.policyError, 'M7.13 claim 返回 policyInstalled');
const liveBuilderVisible = () => liveBuilderAgent.ctx.tools.schemas().map((tool) => tool.name);
assert(
  !liveBuilderVisible().includes('write') && !liveBuilderVisible().includes('edit'),
  'M7.12 live-like builder claim 后 schema 无 write/edit（未知工具不拖垮 filter）',
);
assert(liveBuilderVisible().includes('pwsh'), 'M7.12 live-like builder claim 后保留 pwsh');
liveBuilderForeman.refreshAgentPolicies(); // 模拟 tools:change 的强制重装
assert(
  !liveBuilderVisible().includes('write') && !liveBuilderVisible().includes('edit'),
  'M7.12 live-like builder tools:change 后 schema 仍无 write/edit',
);
assert(liveBuilderVisible().includes('pwsh'), 'M7.12 live-like builder tools:change 后保留 pwsh');
// M7.14：agent 变为非活跃后，重装失败不能覆盖已成功记录；snapshot 只显示当前 root 绑定 agent。
liveBuilderAgent.ctx.effect = () => { throw new Error('cannot create effect on inactive context'); };
liveBuilderForeman.refreshAgentPolicies();
const keptReport = liveBuilderForeman.policyReport.get(liveBuilderAgent.id);
assert(keptReport && keptReport.installedAt && !keptReport.error, 'M7.14 非活跃 agent 重装失败不覆盖成功记录');
liveBuilderForeman.installAgentPolicy(fakeAgent('m714-other-root-agent'));
const liveBuilderSnap = await snapshotAs(liveBuilderForeman, 'live-builder-policy-snap');
assert(
  Array.isArray(liveBuilderSnap.policyReport)
  && liveBuilderSnap.policyReport.some((report) => report.agentId === liveBuilderAgent.id && report.installedAt),
  'M7.13 snapshot policyReport 有 builder 安装记录',
);
assert(
  liveBuilderSnap.policyReport.every((report) => liveBuilderForeman.roster.some((seat) => seat.agentId === report.agentId)),
  'M7.14 snapshot policyReport 只显示当前 root 已绑定 agent',
);
seen.agents.splice(seen.agents.indexOf(liveBuilderAgent), 1);
await rm(rootLiveBuilder, { recursive: true, force: true });

// M7.7 P2：promote 不能把 P0/P1 当卡号替换成 [card]
const p0Archive = await archiveTool.execute({
  action: 'remember',
  cardId: 'G1',
  fingerprint: 'p0-p1-sanitize-fp',
  area: 'sanitize',
  symptom: 'card G1 显示 P0/P1 越权',
  rootCause: 'P0 与 P1 被当成卡号',
  fix: '保留 finding 级别',
}, { agent: { id: claimIds.archivist } });
assert(p0Archive.ok === true, '建含 P0/P1 的归档供 promote');
const p0Promoted = await archiveTool.execute(
  { action: 'promote', id: p0Archive.entry.id, cardId: 'G1' },
  { agent: { id: claimIds.archivist } },
);
assert(p0Promoted.ok === true, 'promote 含 P0/P1 的归档');
assert(
  p0Promoted.lesson.rootCause.includes('P0')
  && p0Promoted.lesson.rootCause.includes('P1')
  && !p0Promoted.lesson.rootCause.includes('[card]'),
  'promote 不把 P0/P1 回落成 [card]',
);
assert(
  p0Promoted.lesson.symptom.includes('[card]') && !p0Promoted.lesson.symptom.includes('G1'),
  'promote 仍脱敏真实 cardId',
);
const p0Demoted = await archiveTool.execute(
  { action: 'demote', id: p0Promoted.lesson.id },
  { agent: { id: claimIds.archivist } },
);
assert(p0Demoted.ok === true, '清理 P0/P1 公共经验');

// M7.8：per-root gate registry（.foreman/gates.json）
await writeFile(join(root, '.foreman', 'gates.json'), JSON.stringify({
  version: 1,
  gates: {
    'gate-cross': { argv: ['node', '-e', 'A-local-cross'], cwd: '.', testsRoot: 'test' },
    'gate-a-only': { argv: ['node', '-e', 'A-only'], cwd: '.', testsRoot: 'test' },
    'gate-local-outside': { argv: ['node', '-e', 'A-outside'], cwd: outsideDir, testsRoot: 'test' },
    'gate-local-allow': {
      argv: ['node', '-e', 'A-allow'], cwd: outsideDir, testsRoot: 'test', allowOutsideRoot: true,
    },
    'gate-bad-local': { cwd: '.' },
  },
}), 'utf8');
await writeFile(join(rootB, '.foreman', 'gates.json'), JSON.stringify({
  version: 1,
  gates: [
    { name: 'gate-cross', argv: ['node', '-e', 'B-local-cross'], cwd: '.', testsRoot: 'test' },
    { name: 'gate-b-local', argv: ['node', '-e', 'B-only'], cwd: '.', testsRoot: 'test' },
  ],
}), 'utf8');

await projectTool.execute({ action: 'use', root }, {});
const aRegistrySnapshot = await foreman.snapshot();
assert(
  aRegistrySnapshot.gateRegistry['gate-cross'].registry === 'project'
  && aRegistrySnapshot.gateRegistry['gate-a-only'].registry === 'project'
  && aRegistrySnapshot.gateRegistry['gate-smoke'].registry === 'config',
  'A 的 registry = 本地 project + config fallback',
);
const r8 = await tool('foreman_card').execute({
  id: 'R8',
  gates: ['gate-cross', 'gate-smoke', 'gate-a-only', 'gate-local-outside', 'gate-local-allow', 'gate-missing', 'gate-bad-local'],
  acceptance: ['registry'],
  setCurrent: false,
}, {});
assert(r8.ok === true, '建 R8 供 per-root gate 测试');

scenario = { exitCode: 0, stdout: 'A local cross', stderr: '', tamper: false, hang: false };
const aCross = await gateTool.execute({ gate: 'gate-cross', cardId: 'R8' }, {});
assert(aCross.ok === true && spawnLog.at(-1).argv[2] === 'A-local-cross', 'A 本地 gate-cross 覆盖 config 并跑本地命令');
assert(
  aCross.registry === 'project' && aCross.entry.registry === 'project' && aCross.entry.root === root,
  'A 证据记录 registry=project / root',
);
const aSmoke = await gateTool.execute({ gate: 'gate-smoke', cardId: 'R8' }, {});
assert(aSmoke.ok === true && aSmoke.registry === 'config' && aSmoke.entry.registry === 'config', '本地未定义的 gate 回退 config');

const cwdSpawnsBefore = spawnLog.length;
const aOutsideBlocked = await gateTool.execute({ gate: 'gate-local-outside', cardId: 'R8' }, {});
assert(
  aOutsideBlocked.ok === false
  && aOutsideBlocked.blocked === 'gate-cwd-outside-root'
  && aOutsideBlocked.registry === 'project'
  && /gates\.json/.test(aOutsideBlocked.error),
  '本地 gate 越界仍拒绝且提示 .foreman/gates.json',
);
assert(spawnLog.length === cwdSpawnsBefore, '越界本地 gate 不 spawn');
const aOutsideAllowed = await gateTool.execute({ gate: 'gate-local-allow', cardId: 'R8' }, {});
assert(
  aOutsideAllowed.ok === true
  && aOutsideAllowed.entry.outsideRoot === true
  && aOutsideAllowed.entry.allowOutsideRoot === true
  && aOutsideAllowed.entry.cwd === outsideDir,
  '本地 allowOutsideRoot gate 放行并记录 outsideRoot',
);

const missingSpawnsBefore = spawnLog.length;
const missingLocal = await gateTool.execute({ gate: 'gate-missing', cardId: 'R8' }, {});
assert(
  missingLocal.ok === false && /当前 root 未注册 gate/.test(missingLocal.error) && missingLocal.registry === 'none',
  '当前 root 缺失 gate 明确报错',
);
assert(spawnLog.length === missingSpawnsBefore, '缺失 gate 不 spawn');
const badLocal = await gateTool.execute({ gate: 'gate-bad-local', cardId: 'R8' }, {});
assert(badLocal.ok === false && /定义无效/.test(badLocal.error), '本地 gate 定义无效明确报错');

await projectTool.execute({ action: 'use', root: rootB }, {});
const bRegistrySnapshot = await foreman.snapshot();
assert(bRegistrySnapshot.root === rootB && bRegistrySnapshot.gateRegistry['gate-cross'].registry === 'project', 'B 使用自己的本地 registry');
assert(!bRegistrySnapshot.gateRegistry['gate-a-only'] && !bRegistrySnapshot.gateRegistry['gate-bad-local'], '切 B 后看不到 A 的本地 gate');
const s8 = await tool('foreman_card').execute({
  id: 'S8',
  gates: ['gate-cross', 'gate-a-only', 'gate-b-local'],
  acceptance: ['B registry'],
  setCurrent: false,
}, {});
assert(s8.ok === true, 'B 建 S8 供 per-root gate 测试');
scenario = { exitCode: 0, stdout: 'B local cross', stderr: '', tamper: false, hang: false };
const bCross = await gateTool.execute({ gate: 'gate-cross', cardId: 'S8' }, {});
assert(bCross.ok === true && spawnLog.at(-1).argv[2] === 'B-local-cross', 'B 同名 gate 跑 B 自己的命令');
assert(bCross.entry.registry === 'project' && bCross.entry.root === rootB, 'B 证据记录 registry/root');
const bOnly = await gateTool.execute({ gate: 'gate-b-local', cardId: 'S8' }, {});
assert(bOnly.ok === true && bOnly.entry.registry === 'project', 'B 本地独有 gate 可跑');
const bStaleGate = await gateTool.execute({ gate: 'gate-a-only', cardId: 'S8' }, {});
assert(bStaleGate.ok === false && /当前 root 未注册 gate/.test(bStaleGate.error), '切 B 后不沿用 A 的本地 gate');
const bMissing = await foreman.missingGates('S8', s8.card);
assert(bMissing.includes('gate-a-only') && !bMissing.includes('gate-cross'), 'missingGates 使用当前 root registry');

await projectTool.execute({ action: 'use', root }, {});
const backRegistry = (await foreman.snapshot()).gateRegistry;
assert(backRegistry['gate-cross'].registry === 'project' && Boolean(backRegistry['gate-a-only']), '切回 A 重载 A 的 registry');
scenario = { exitCode: 0, stdout: 'A local cross again', stderr: '', tamper: false, hang: false };
const aCrossAgain = await gateTool.execute({ gate: 'gate-cross', cardId: 'R8' }, {});
assert(aCrossAgain.ok === true && spawnLog.at(-1).argv[2] === 'A-local-cross', '切回 A 不沿用 B 的 gate');
await tool('foreman_card').execute({ id: 'R8', setCurrent: true }, {});
const registryStatus = await seen.command.handler({ rawInput: 'status', agent: { id: 'session-1' } });
assert(
  registryStatus.kind === 'success'
  && /门禁注册：project \d+ \/ config \d+/.test(registryStatus.text)
  && registryStatus.text.includes('registry project'),
  'status 显示当前 root 的 gate registry',
);

// M7.9：claim 时 agent schemas 短暂为空，仍必须装 coder deny filter；再刷新一轮仍保留
const rootC = resolve(join(tmpdir(), `foreman-m2-smoke-c-${process.pid}-${Date.now()}`));
await mkdir(rootC, { recursive: true });
const emptySchemaProbe = fakeAgent('coder-empty-schema-probe', { schemas: () => [] });
seen.agents.push(emptySchemaProbe);
const claimForemanC = new Foreman(ctx, {
  root: rootC,
  goal: '冒烟项目C',
  gates: gateConfig,
  roster: rosterConfig,
  gateGraceMs: 20,
  sharedLessonsPath: sharedFile,
});
await claimForemanC.ensureReady();
const emptySchemaClaim = await claimForemanC.withRoot(
  { agent: { id: emptySchemaProbe.id } },
  () => claimForemanC.setSeat(
    { action: 'claim', seat: 'coder' },
    { agent: { id: emptySchemaProbe.id } },
  ),
);
assert(emptySchemaClaim.ok === true, '空 schema agent claim coder 成功');
const emptyClaimFilter = seen.filters.filter((entry) => entry.agentId === emptySchemaProbe.id).at(-1)?.filter;
assert(
  emptyClaimFilter && Array.isArray(emptyClaimFilter.deny)
  && emptyClaimFilter.deny.includes('foreman_verdict')
  && emptyClaimFilter.deny.includes('foreman_stage'),
  'claim 时 schemas 为空也装 coder deny filter',
);
claimForemanC.refreshAgentPolicies(); // 模拟 tools:change 的强制重装
const emptyReplayFilter = seen.filters.filter((entry) => entry.agentId === emptySchemaProbe.id).at(-1)?.filter;
assert(
  emptyReplayFilter && Array.isArray(emptyReplayFilter.deny)
  && emptyReplayFilter.deny.includes('foreman_verdict')
  && emptyReplayFilter.deny.includes('foreman_stage'),
  'tools:change 强制重装后 coder deny filter 仍在',
);

// M7.9：已绑定席位 claim 未知 seat → 先报“未知席位”
const boundUnknownSeat = await claimTool.execute(
  { action: 'claim', seat: 'wizard' },
  { agent: { id: claimIds.coder } },
);
assert(boundUnknownSeat.ok === false && /未知席位/.test(boundUnknownSeat.error), '已绑定席位 claim 未知 seat 先报未知席位');
const guardUnknownSeat = guard({
  name: 'foreman_seat',
  agent: { id: claimIds.reviewer },
  arguments: { action: 'claim', seat: 'wizard' },
});
assert(typeof guardUnknownSeat === 'string' && /未知席位/.test(guardUnknownSeat), 'guard claim 未知 seat 也先报未知席位');

// M7.9：state.cardId=null 时不回退最近卡
const nullCard = await tool('foreman_card').execute(
  { id: 'NULLCARD', gates: [], acceptance: ['no current card'], setCurrent: true },
  {},
);
assert(nullCard.ok === true && nullCard.current === 'NULLCARD', '建 NULLCARD 并设为当前卡');
const nullDelete = await tool('foreman_card').execute({ action: 'delete', id: 'NULLCARD' }, {});
assert(nullDelete.ok === true, '删当前卡后 cardId 置空');
const nullSnapshot = await foreman.snapshot();
assert(nullSnapshot.card === null && nullSnapshot.state.cardId === null, '无当前卡时 snapshot.card 不回退最近卡');
const nullStatus = await seen.command.handler({ rawInput: 'status', agent: { id: 'session-1' } });
assert(nullStatus.kind === 'success' && nullStatus.text.includes('当前卡：无'), 'status 显示无当前卡');
const nullProjectStatus = await projectTool.execute({ action: 'status' }, {});
assert(nullProjectStatus.ok === true && nullProjectStatus.card === null, 'project status 显示无当前卡');
// M7.15：lastVerdict 只显示当前卡自己的裁决，不把旧卡裁决挂到新卡上。
await tool('foreman_card').execute({ id: 'VERDICT-OLD', gates: [], acceptance: ['old'], setCurrent: true }, {});
await tool('foreman_verdict').execute({ cardId: 'VERDICT-OLD', verdict: 'RETURN', summary: 'old verdict' }, {});
await tool('foreman_card').execute({ id: 'VERDICT-NEW', gates: [], acceptance: ['new'], setCurrent: true }, {});
const lvSnap = await snapshotAs(foreman, 'lastverdict-filter');
assert(lvSnap.lastVerdict === null, 'M7.15 新卡 snapshot 不带旧卡 lastVerdict');
const lvStatus = await seen.command.handler({ rawInput: 'status', agent: { id: 'session-1' } });
assert(lvStatus.kind === 'success' && !/最近裁决/.test(lvStatus.text), 'M7.15 status 不显示旧卡最近裁决');
await tool('foreman_card').execute({ action: 'delete', id: 'VERDICT-NEW' }, {});
await tool('foreman_card').execute({ action: 'delete', id: 'VERDICT-OLD' }, {});
// M7.17：lastVerdict 还要按卡实例过滤——同名重建后，旧卡裁决不得挂到新卡上。
await tool('foreman_card').execute({ id: 'VERDICT-OLD', gates: [], acceptance: ['rebuilt'], setCurrent: true }, {});
const lvRebuildSnap = await snapshotAs(foreman, 'lastverdict-rebuild');
assert(lvRebuildSnap.lastVerdict === null, 'M7.17 同名重建 snapshot 不带旧实例 lastVerdict');
await tool('foreman_card').execute({ action: 'delete', id: 'VERDICT-OLD' }, {});
// M7.17：Reviewer 自动开挑战与 guard 同源（跨 rootStates），本地 roster 没 reviewer 也要开挑战。
const crossRootKey = 'L:\\fake\\cross-root-m717';
foreman.rootStates.set(crossRootKey, { roster: [{ id: 'reviewer', agentId: 'cross-reviewer' }, { id: 'nitpicker', agentId: 'cross-nitpicker' }] });
await tool('foreman_card').execute({ id: 'M717-CROSS', gates: [], acceptance: ['cross'], setCurrent: true }, {});
const crossVerdict = await tool('foreman_verdict').execute({ cardId: 'M717-CROSS', verdict: 'ACCEPT', summary: 'cross reviewer' }, { agent: { id: 'cross-reviewer' } });
assert(crossVerdict.ok === false && crossVerdict.challengeOpened === true, 'M7.17 跨 root Reviewer ACCEPT 自动开挑战');
foreman.rootStates.delete(crossRootKey);
await tool('foreman_card').execute({ action: 'delete', id: 'M717-CROSS' }, {});

// M7.11：删卡级联清理该 cardId 的 evidence/challenges/archive；同名重建不继承；decisions 保留
const delCardId = 'M711-DEL';
const keepCardId = 'M711-KEEP';
const delCard = await tool('foreman_card').execute({
  id: delCardId,
  scopeDo: ['delete cascade probe'],
  acceptance: ['delete cascade'],
  gates: ['gate-smoke'],
  setCurrent: true,
}, {});
assert(delCard.ok === true && delCard.current === delCardId, 'M7.11 建待删卡并设为当前卡');
const keepCard = await tool('foreman_card').execute({
  id: keepCardId,
  gates: ['gate-syntax'],
  acceptance: ['keep history'],
  setCurrent: false,
}, {});
assert(keepCard.ok === true, 'M7.11 建对照卡');

scenario = { exitCode: 0, stdout: 'M711 cascade evidence', stderr: '', tamper: false, hang: false };
const delGate = await gateTool.execute({ gate: 'gate-smoke', cardId: delCardId, timeoutMs: 500 }, {});
const keepGate = await gateTool.execute({ gate: 'gate-syntax', cardId: keepCardId, timeoutMs: 500 }, {});
assert(delGate.ok === true && delGate.passed === true, 'M7.11 待删卡写 gate 证据');
assert(keepGate.ok === true && keepGate.passed === true, 'M7.11 对照卡写 gate 证据');

const delChallenge = await challengeTool.execute({
  action: 'open',
  cardId: delCardId,
  note: 'M711 delete cascade challenge',
}, {});
const keepChallenge = await challengeTool.execute({
  action: 'open',
  cardId: keepCardId,
  note: 'M711 keep challenge',
}, {});
assert(delChallenge.ok === true && delChallenge.challenge.status === 'open', 'M7.11 待删卡开 challenge');
assert(keepChallenge.ok === true && keepChallenge.challenge.status === 'open', 'M7.11 对照卡开 challenge');

const delArchive = await archiveTool.execute({
  action: 'remember',
  cardId: delCardId,
  fingerprint: 'm711-delete-cascade',
  area: 'delete',
  symptom: '同名重建继承旧数据',
  repro: '建卡→证据→挑战→归档→删除→同 id 重建',
  rootCause: 'deleteCard 只删卡文件',
  fix: '级联清理 evidence/challenges/archive',
}, {});
const keepArchive = await archiveTool.execute({
  action: 'remember',
  cardId: keepCardId,
  fingerprint: 'm711-keep-history',
  area: 'delete',
  symptom: '对照卡历史',
  repro: 'n/a',
  rootCause: 'n/a',
  fix: 'n/a',
}, {});
assert(delArchive.ok === true && delArchive.entry.cardId === delCardId, 'M7.11 待删卡写 archive');
assert(keepArchive.ok === true && keepArchive.entry.cardId === keepCardId, 'M7.11 对照卡写 archive');

const decisionsBeforeDelete = await readFile(join(root, '.foreman', 'decisions.md'), 'utf8');
const beforeEvidence = JSON.parse(await readFile(join(root, '.foreman', 'evidence.json'), 'utf8'));
const beforeChallenges = JSON.parse(await readFile(join(root, '.foreman', 'challenges.json'), 'utf8'));
const beforeArchive = JSON.parse(await readFile(join(root, '.foreman', 'archive.json'), 'utf8'));
const keepEvidenceIds = beforeEvidence.entries.filter((entry) => entry.cardId === keepCardId).map((entry) => entry.id);
const keepChallengeIds = beforeChallenges.entries.filter((entry) => entry.cardId === keepCardId).map((entry) => entry.id);
const keepArchiveIds = beforeArchive.entries.filter((entry) => entry.cardId === keepCardId).map((entry) => entry.id);
assert(
  beforeEvidence.entries.some((entry) => entry.cardId === delCardId)
  && keepEvidenceIds.length > 0
  && beforeChallenges.entries.some((entry) => entry.cardId === delCardId)
  && keepChallengeIds.length > 0
  && beforeArchive.entries.some((entry) => entry.cardId === delCardId)
  && keepArchiveIds.length > 0,
  'M7.11 删除前两张卡都有 evidence/challenge/archive',
);

const deleted = await tool('foreman_card').execute({ action: 'delete', id: delCardId }, {});
assert(deleted.ok === true && deleted.deleted === delCardId, 'M7.11 删卡成功');
assert(
  deleted.cleaned
  && deleted.cleaned.evidence >= 1
  && deleted.cleaned.challenges >= 1
  && deleted.cleaned.archive >= 1,
  'M7.11 删卡返回三类清理计数',
);

const afterDelete = await foreman.snapshot();
assert(
  afterDelete.card === null
  && afterDelete.state.cardId === null
  && afterDelete.state.stage === 'idle',
  'M7.11 删除当前卡后 cardId 空、stage idle',
);
const afterEvidence = JSON.parse(await readFile(join(root, '.foreman', 'evidence.json'), 'utf8'));
const afterChallenges = JSON.parse(await readFile(join(root, '.foreman', 'challenges.json'), 'utf8'));
const afterArchive = JSON.parse(await readFile(join(root, '.foreman', 'archive.json'), 'utf8'));
assert(!afterEvidence.entries.some((entry) => entry.cardId === delCardId), 'M7.11 删除后 evidence 无该卡条目');
assert(!afterChallenges.entries.some((entry) => entry.cardId === delCardId), 'M7.11 删除后 challenges 无该卡条目');
assert(!afterArchive.entries.some((entry) => entry.cardId === delCardId), 'M7.11 删除后 archive 无该卡条目');
assert(
  keepEvidenceIds.every((id) => afterEvidence.entries.some((entry) => entry.id === id))
  && keepChallengeIds.every((id) => afterChallenges.entries.some((entry) => entry.id === id))
  && keepArchiveIds.every((id) => afterArchive.entries.some((entry) => entry.id === id)),
  'M7.11 删卡不改其他卡历史',
);
assert(
  !afterDelete.evidence.some((entry) => entry.cardId === delCardId)
  && !afterDelete.challenges.some((entry) => entry.cardId === delCardId)
  && !afterDelete.archive.some((entry) => entry.cardId === delCardId),
  'M7.11 删除后 snapshot 不再含该卡旧数据',
);
const lessonsAfterDelete = await readFile(join(root, 'LESSONS.md'), 'utf8');
assert(!lessonsAfterDelete.includes('m711-delete-cascade'), 'M7.11 LESSONS 同步移除该卡归档');
assert(lessonsAfterDelete.includes('m711-keep-history'), 'M7.11 LESSONS 保留其他卡归档');
const decisionsAfterDelete = await readFile(join(root, '.foreman', 'decisions.md'), 'utf8');
assert(decisionsAfterDelete.startsWith(decisionsBeforeDelete), 'M7.11 删卡不改写旧 decisions');
assert(decisionsAfterDelete.includes(`删除契约 ${delCardId}`), 'M7.11 删除动作写 decisions 审计');

const rebuilt = await tool('foreman_card').execute({
  id: delCardId,
  gates: ['gate-smoke'],
  acceptance: ['fresh rebuild'],
  setCurrent: true,
}, {});
assert(rebuilt.ok === true && rebuilt.current === delCardId, 'M7.11 同 id 重建并设为当前卡');
const rebuiltSnapshot = await foreman.snapshot();
assert(
  rebuiltSnapshot.card
  && rebuiltSnapshot.card.id === delCardId
  && !rebuiltSnapshot.evidence.some((entry) => entry.cardId === delCardId)
  && !rebuiltSnapshot.challenges.some((entry) => entry.cardId === delCardId)
  && !rebuiltSnapshot.archive.some((entry) => entry.cardId === delCardId),
  'M7.11 同名重建 snapshot 无旧证据/挑战/归档',
);
const rebuiltMissing = await foreman.missingGates(delCardId, rebuilt.card);
assert(rebuiltMissing.includes('gate-smoke'), 'M7.11 同名重建门禁证据仍缺失（未继承旧证据）');
const rebuiltStatus = await tool('foreman_status').execute({}, {});
assert(
  rebuiltStatus.summary.includes('gate-smoke:未跑')
  && !rebuiltStatus.summary.includes('gate-smoke:exit 0')
  && rebuiltStatus.summary.includes('挑战：无 open')
  && rebuiltStatus.summary.includes('归档：open 0')
  && !rebuiltStatus.summary.includes('m711-delete-cascade'),
  'M7.11 同名重建 status 显示 gate 未跑/无挑战/无归档',
);

// M7.16：freezeManifest 逐文件基线 + ACCEPT 越界变更拦截（gate 前改测试/新增文件）
const manifestRoot = resolve(join(tmpdir(), `foreman-m2-smoke-manifest-${process.pid}-${Date.now()}`));
await rm(manifestRoot, { recursive: true, force: true });
await mkdir(join(manifestRoot, 'src'), { recursive: true });
await mkdir(join(manifestRoot, 'tests'), { recursive: true });
const manifestFishPath = join(manifestRoot, 'src', 'fish.mjs');
const manifestExtraPath = join(manifestRoot, 'src', 'extra.mjs');
const manifestTestsPath = join(manifestRoot, 'tests', 'game.test.mjs');
const manifestFish = 'export const fish = 1;\n';
const manifestTests = '// game test baseline\n';
await writeFile(manifestFishPath, manifestFish, 'utf8');
await writeFile(manifestTestsPath, manifestTests, 'utf8');
const manifestGateConfig = {
  'gate-manifest': {
    cwd: manifestRoot,
    argv: ['node', '-e', 'manifest gate ok'],
    testsRoot: 'tests',
    timeoutMs: 500,
  },
};
const manifestForeman = new Foreman(ctx, {
  root: manifestRoot,
  goal: 'manifest',
  gates: manifestGateConfig,
  roster: rosterConfig,
  gateGraceMs: 20,
  sharedLessonsPath: sharedFile,
});
await manifestForeman.ensureReady();
const manifestCard = await manifestForeman.upsertCard({
  id: 'FISH-M716',
  scopeDo: ['实现 fish.mjs'],
  scopeNot: ['改 tests/'],
  acceptance: ['gate 全绿', '只改 src/fish.mjs'],
  gates: ['gate-manifest'],
  allowedFiles: ['src/fish.mjs'],
  setCurrent: true,
}, {});
assert(
  manifestCard.ok === true && Array.isArray(manifestCard.card.allowedFiles)
  && manifestCard.card.allowedFiles[0] === 'src/fish.mjs',
  'M7.16 建卡写入 allowedFiles',
);
const manifestFrozen = await manifestForeman.freezeCard({ id: 'FISH-M716', signedBy: '主持' }, {});
const manifestEntries = manifestFrozen.card && manifestFrozen.card.freezeManifest
  ? manifestFrozen.card.freezeManifest.entries : [];
assert(
  manifestFrozen.ok === true
  && manifestFrozen.card.freezeManifest
  && typeof manifestFrozen.card.freezeManifest.at === 'number'
  && manifestEntries.some((entry) => entry.path === 'src/fish.mjs'
    && /^[0-9a-f]{64}$/.test(entry.sha256) && entry.bytes > 0)
  && manifestEntries.some((entry) => entry.path === 'tests/game.test.mjs'),
  'M7.16 freeze 写入逐文件 freezeManifest（path/sha256/bytes/at）',
);
const manifestStatus = await manifestForeman.statusText();
assert(
  /基线锚点：2 文件（冻结于 /.test(manifestStatus),
  'M7.16 statusText 显示基线锚点行',
);

scenario = { exitCode: 0, stdout: 'manifest gate', stderr: '', tamper: false, hang: false };
await writeFile(manifestTestsPath, '// game test changed before gate\n', 'utf8');
const testsChangedGate = await manifestForeman.runGate({ gate: 'gate-manifest', cardId: 'FISH-M716' }, {});
assert(testsChangedGate.ok === true && testsChangedGate.passed === true, 'M7.16 gate 前改测试后 gate 本身仍通过');
const testsChangedVerdict = await manifestForeman.recordVerdict({ cardId: 'FISH-M716', verdict: 'ACCEPT' }, {});
assert(
  testsChangedVerdict.ok === false
  && testsChangedVerdict.error.includes('tests/game.test.mjs'),
  'M7.16 tests 改动后 ACCEPT 被拒且 error 含路径',
);
assert(
  (await manifestForeman.snapshot()).state.lastVerdict === null,
  'M7.16 基线拒绝不写 verdict',
);

await writeFile(manifestTestsPath, manifestTests, 'utf8');
await writeFile(manifestExtraPath, 'export const extra = 1;\n', 'utf8');
const extraGate = await manifestForeman.runGate({ gate: 'gate-manifest', cardId: 'FISH-M716' }, {});
assert(extraGate.ok === true && extraGate.passed === true, 'M7.16 新增 extra 后 gate 本身仍通过');
const extraVerdict = await manifestForeman.recordVerdict({ cardId: 'FISH-M716', verdict: 'ACCEPT' }, {});
assert(
  extraVerdict.ok === false && extraVerdict.error.includes('src/extra.mjs'),
  'M7.16 新增 scope 外文件 ACCEPT 被拒且 error 含路径',
);

await rm(manifestExtraPath, { force: true });
await writeFile(manifestFishPath, 'export const fish = 2;\n', 'utf8');
const allowedGate = await manifestForeman.runGate({ gate: 'gate-manifest', cardId: 'FISH-M716' }, {});
assert(allowedGate.ok === true && allowedGate.passed === true, 'M7.16 只改 allowedFiles 文件后 gate 通过');
const allowedVerdict = await manifestForeman.recordVerdict({ cardId: 'FISH-M716', verdict: 'ACCEPT' }, {});
assert(
  allowedVerdict.ok === true && allowedVerdict.verdict === 'ACCEPT',
  'M7.16 只改 allowedFiles 允许文件时 ACCEPT 放行',
);

// 默认重复 freeze 保留原基线；显式 rebaseManifest 才重拍
const manifestBeforeRefreeze = JSON.stringify(manifestFrozen.card.freezeManifest.entries);
await writeFile(manifestFishPath, 'export const fish = 3;\n', 'utf8');
const manifestRefreeze = await manifestForeman.freezeCard({ id: 'FISH-M716', signedBy: '主持' }, {});
assert(
  manifestRefreeze.ok === true
  && JSON.stringify(manifestRefreeze.card.freezeManifest.entries) === manifestBeforeRefreeze,
  'M7.16 重复 freeze 默认保留原基线',
);
const manifestRebased = await manifestForeman.freezeCard(
  { id: 'FISH-M716', signedBy: '主持', rebaseManifest: true },
  {},
);
assert(
  manifestRebased.ok === true
  && JSON.stringify(manifestRebased.card.freezeManifest.entries) !== manifestBeforeRefreeze,
  'M7.16 rebaseManifest=true 重拍基线',
);

const legacyCard = await manifestForeman.upsertCard({
  id: 'LEGACY-M716',
  gates: [],
  acceptance: ['legacy no manifest'],
  setCurrent: false,
}, {});
const legacyVerdict = await manifestForeman.recordVerdict({ cardId: 'LEGACY-M716', verdict: 'ACCEPT' }, {});
assert(
  legacyCard.ok === true && legacyVerdict.ok === true,
  'M7.16 无 freezeManifest 的旧卡行为不变',
);
await rm(manifestRoot, { recursive: true, force: true });

// M7.9：bindings.json 只写当前 root 的 bindingSessions 键
foreman.bindingSessions.set(rootB, 'other-root-session-probe');
await foreman.persistBindings();
const bindingsProbeDisk = JSON.parse(await readFile(join(root, '.foreman', 'bindings.json'), 'utf8'));
const sessionKeys = Object.keys(bindingsProbeDisk.bindingSessions || {});
assert(sessionKeys.length === 1 && sessionKeys[0] === root, 'bindings.json 只写当前 root 的 session 键');
assert(
  !JSON.stringify(bindingsProbeDisk).includes('other-root-session-probe'),
  'bindings.json 不携带其他 root 的 session 元数据',
);

await rm(root, { recursive: true, force: true });
await rm(rootB, { recursive: true, force: true });
await rm(rootC, { recursive: true, force: true });
await rm(rootClaimOrderA, { recursive: true, force: true });
await rm(rootClaimOrderB, { recursive: true, force: true });
await rm(rootClaimOrderC, { recursive: true, force: true });
await rm(outsideDir, { recursive: true, force: true });
await rm(dirname(sharedFile), { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
