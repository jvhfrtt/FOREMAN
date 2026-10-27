/**
 * 监工台对外的三个口子：
 * - 模型工具：status / card / evidence / verdict / seat / stage
 * - 人类命令：/foreman status | resume | card <id> | help
 * - 面板只读路由：GET /foreman/api/snapshot
 * 写入只走工具和命令，面板不写任何东西。
 */

const STAGES = ['idle', 'meeting', 'implement', 'review', 'build', 'verify', 'accept', 'return'];
const SEAT_STATUS = ['idle', 'working', 'done', 'blocked'];
const SCHEMA = { type: 'object', additionalProperties: true };

function renderJson(args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** 每个工具都必须给出 output.render：模型看到的就是这里返回的内容。 */
function output(render = renderJson) {
  return { schema: SCHEMA, render };
}

function stringList(description) {
  return { type: 'array', items: { type: 'string' }, description };
}

export function createTools(foreman) {
  return [
    {
      name: 'foreman_status',
      description:
        '读取监工台当前状态：阶段、当前任务卡、验收项、门禁证据、P0/P1、五席状态、公共经验条数。开工前、交付前、以及不确定"现在到哪了"时先调这个。只读，不改变任何东西。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: output((args, value) => [{ type: 'text', text: String((value && value.summary) || JSON.stringify(value, null, 2)) }]),
      async execute(args, exec) {
        return foreman.withRoot(exec, async () => ({ ok: true, summary: await foreman.statusText() }));
      },
    },

    {
      name: 'foreman_project',
      description:
        'M3.3 按调用者 agent 隔离 root：action=use 传绝对路径 root，只切当前 agent/session 的 root；无 agent 标识时用 default root。action=status 显示调用者 active root 和当前卡。panel 使用 default/last active root；插件内所有工具数据按 root 隔离。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['use', 'status'], description: 'use 切换；status 查看 active root。' },
          root: { type: 'string', description: 'use 必填：项目绝对路径。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.runProject(args, exec));
      },
    },

    {
      name: 'foreman_card',
      description:
        '任务契约卡（只有主持/未绑定调用者可建改冻结删除；席位只能用 foreman_status 读）：没有契约不开工。action=upsert 建卡或改卡（id 必填，例如 A4）；action=freeze 由主持签字冻结并拍 freezeManifest 逐文件基线；action=delete 删卡（级联清理该卡 evidence/challenges/archive，decisions 审计保留）。已冻结的卡再改范围/验收/门禁/允许文件，必须同时传 signedBy 与 signNote；默认保留原冻结基线，只有 rebaseManifest=true 才重拍。ACCEPT 会用 freezeManifest 与 allowedFiles 强制比对，tests/新增文件等越界变更直接拒绝。验收项和门禁要写成可判定的句子，不要写"体验良好"这类。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['upsert', 'freeze', 'delete'], description: '默认 upsert。' },
          id: { type: 'string', description: '任务卡 id，例如 A4 或 M2-03。' },
          scopeDo: stringList('本段要做的事，一条一句。'),
          scopeNot: stringList('本段明确不做的事，用来防止范围蔓延。'),
          acceptance: stringList('验收标准，每条都能被判真假，例如 "preview 59/6 == lastResolve"。'),
          gates: stringList('必须过的门禁命令名，例如 tsc / vitest / build / shot。'),
          artifacts: stringList('要留下的产物，例如 screenshots / json。'),
          allowedFiles: stringList('允许在冻结基线之后变更的相对 root 路径；支持精确路径和 dir/**。'),
          rebaseManifest: { type: 'boolean', description: '为 true 时按当前文件树重拍 freezeManifest 基线（首次需先 freeze）。' },
          note: { type: 'string', description: '备注。' },
          setCurrent: { type: 'boolean', description: '是否把这卡设为当前卡，默认 true。' },
          signedBy: { type: 'string', description: '主持签字人（改冻结卡、或 freeze 时必填）。' },
          signNote: { type: 'string', description: '签字理由，建议写清为什么改范围。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => {
          const action = String(args.action || 'upsert');
          if (action === 'freeze') return foreman.freezeCard(args, exec);
          if (action === 'delete') return foreman.deleteCard(args, exec);
          return foreman.upsertCard(args, exec);
        });
      },
    },

    {
      name: 'foreman_evidence',
      description:
        '登记一条证据：哪张卡、哪个门禁、什么命令、退出码多少、输出尾部、产物文件。插件会校验产物路径存在并记下字节数和 sha256；退出码非 0 会自动变成 P0。注意：M1 的 exitCode 和 output 是调用方申报值（source=reported），真正的门禁复跑要等 M2 的 foreman_gate。不要用这个工具编造"已通过"。',
      parameters: {
        type: 'object',
        properties: {
          gate: { type: 'string', description: '门禁名，例如 tsc / vitest / build / shot。' },
          cardId: { type: 'string', description: '任务卡 id，默认当前卡。' },
          cmd: { type: 'string', description: '实际执行的命令，含参数。' },
          exitCode: { type: 'number', description: '实际退出码。' },
          output: { type: 'string', description: '输出尾部（会截断到 4000 字符）。失败时要保留原始错误。' },
          files: stringList('产物路径，相对项目根目录，例如 dist/index.html 或 screenshots/a4.png。'),
          note: { type: 'string', description: '补充说明。' },
        },
        required: ['gate'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.addEvidence({ ...args, by: exec && exec.agent ? exec.agent.id : null }));
      },
    },

    {
      name: 'foreman_gate',
      description:
        '运行一个已注册的 M2 门禁：按当前 root 的 .foreman/gates.json 执行（未定义时回退 config.gates，同名以项目本地为准），模型只能传 gate 名，不能传 argv/shell/cmd。cwd 缺省/相对路径按当前 active root 解析；绝对 cwd 不在当前 root 内时默认拒绝，不 spawn、不写证据，只有显式 allowOutsideRoot: true 的 gate 例外。证据记录 registry=project|config 与 root/cwd；gate 失败/超时自动 P0，并在前后对 tests/** 与源码做 sha256 快照，篡改自动 P0 并拒绝 ACCEPT。',
      parameters: {
        type: 'object',
        properties: {
          gate: { type: 'string', description: '卡上已声明的门禁名，例如 gate-smoke。' },
          cardId: { type: 'string', description: '任务卡 id，默认当前卡。' },
          timeoutMs: { type: 'number', description: '本次超时毫秒，默认插件配置；不允许传命令参数。' },
        },
        required: ['gate'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.runGate(args, exec));
      },
    },

    {
      name: 'foreman_challenge',
      description:
        'M3/M7 Nitpicker 挑战：action=open 开启（同卡已有 open 时返回已有挑战，不重复）、resolve 由当前会话绑定的 Nitpicker 给出 cleared|blocked、waive/cancel 由主持关闭（reason+evidence 必填）、list 按卡查询。挑战存 assignedSeat，不依赖旧 agentId；ACCEPT 接受 cleared/waived，open/blocked 仍拒绝。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'resolve', 'list', 'waive', 'cancel'], description: '操作。' },
          cardId: { type: 'string', description: '任务卡 id，默认当前卡。' },
          decision: { type: 'string', enum: ['cleared', 'blocked'], description: 'resolve 结论。' },
          reason: { type: 'string', description: 'waive/cancel 原因，必填。' },
          evidence: { type: 'string', description: 'waive/cancel 证据 id，必填。' },
          note: { type: 'string', description: '挑战备注。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.runChallenge(args, exec));
      },
    },

    {
      name: 'foreman_archive',
      description:
        'M4/M6 Archivist：项目 archive + 跨项目 shared lessons。remember/search/list/resolve 作用于项目；promote/demote 人工维护公共经验；scope=project|global|both。公共经验只提示不阻断，项目 open 仍只阻断本项目。promote 只保留 pattern/area/symptom/rootCause/fixPattern/regressionGuard 并脱敏。治理：变更动作只允许 Archivist 或主持；其他席位只读 search/list。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['remember', 'search', 'list', 'resolve', 'promote', 'demote'], description: '操作。' },
          scope: { type: 'string', enum: ['project', 'global', 'both'], description: '查询/操作范围，默认 project。' },
          id: { type: 'string', description: '项目归档 id（resolve/promote）或公共经验 id（demote）。' },
          fingerprint: { type: 'string', description: '复发指纹；remember 必填。' },
          area: { type: 'string', description: '区域。' },
          symptom: { type: 'string', description: '症状。' },
          repro: { type: 'string', description: '复现步骤。' },
          rootCause: { type: 'string', description: '根因。' },
          fix: { type: 'string', description: '修复。' },
          regressionGuard: { type: 'string', description: '回归守卫；fixed 必填。' },
          status: { type: 'string', enum: ['open', 'fixed', 'wontfix'], description: 'list 过滤 / resolve 目标状态。' },
          cardId: { type: 'string', description: '任务卡 id，默认当前卡。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.runArchive(args, exec));
      },
    },

    {
      name: 'foreman_reputation',
      description:
        'M5 信誉账本：status/award/penalize/list。award/penalize 必须带 seat、正数 delta、reason、evidence（archive/gate/challenge/decision id）；只有未绑定主持可调整，archivist 只读。分 0-100，>=85 high / 60-84 normal / 40-59 watch / <40 breaker；任一绑定席位 breaker 会阻断 ACCEPT。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'award', 'penalize', 'list'], description: '操作。' },
          seat: { type: 'string', description: '席位 id，例如 coder；award/penalize 必填。' },
          delta: { type: 'number', description: '正数分值；award 加分、penalize 扣分。' },
          reason: { type: 'string', description: '调整原因；award/penalize 必填。' },
          evidence: { type: 'string', description: '证据 id，例如 A1 / E2 / C1；award/penalize 必填。' },
          cardId: { type: 'string', description: '关联任务卡，默认当前卡。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.runReputation(args, exec));
      },
    },

    {
      name: 'foreman_verdict',
      description:
        '下裁决（只有 Reviewer 或主持可调用）。ACCEPT 前插件会自己检查：P0 必须清零，且卡上每个门禁都得有一条 exit 0 的证据——缺一条就拒绝，并告诉你缺什么。RETURN 会把 p0/p1 记进状态，卡变为 returned。裁决会追加到 decisions.md，谁下的由会话 id 记录。',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: '任务卡 id，默认当前卡。' },
          verdict: { type: 'string', enum: ['ACCEPT', 'RETURN'], description: 'ACCEPT 或 RETURN。' },
          summary: { type: 'string', description: '一句话结论。' },
          p0: stringList('阻断级问题：必须立刻修。'),
          p1: stringList('重要问题：本轮内应修。'),
          p2: stringList('可延后问题。'),
        },
        required: ['verdict'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.recordVerdict(args, exec));
      },
    },

    {
      name: 'foreman_seat',
      description:
        '更新五席状态（idle / working / done / blocked）、席位自注册 claim、单席 bind 或五席 rebind。action=claim 由当前 agent 会话自注册 seat：agentId 只取 exec.agent.id，不接受自报，且只能 claim 自己当前的空席位；仅在 rebind-required 或该 seat 未绑定时允许，seat 已绑给存活 agent / 同一 agent 已占别的 seat / retired 都会被拒。claim 写 bindings/roster/state、旧 id 进 retired，五席 claim 齐后自动 bound 并清 rebind-required，且立即安装该席 ACL/schema。bind/rebind 只有主持（未绑定调用者）可以。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['update', 'claim', 'bind', 'rebind'], description: '默认 update；claim 只需 seat（agentId 取调用者）；bind 需要 seat+agentId；rebind 需要 agents 五席对象。' },
          seat: { type: 'string', enum: ['coder', 'reviewer', 'builder', 'nitpicker', 'archivist'], description: '席位 id（update/claim/bind）。' },
          status: { type: 'string', enum: SEAT_STATUS, description: 'update 状态。' },
          note: { type: 'string', description: '一句话说明，例如"正在跑 vitest"。' },
          agentId: { type: 'string', description: 'bind 的当前会话真实 agentId；claim 忽略此字段（只认 exec.agent.id）。' },
          agents: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'rebind 五席对象：coder/reviewer/builder/nitpicker/archivist -> agentId。',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.setSeat(args, exec));
      },
    },

    {
      name: 'foreman_stage',
      description:
        '推进流水线阶段（只有主持可调用）：meeting 会议 → implement 实现 → review 审查 → build 构建 → verify 验收 → accept 已验收 / return 已退回。面板顶部显示这个阶段；裁决会自动改它，手工调用用于进入会议或审查。',
      parameters: {
        type: 'object',
        properties: {
          stage: { type: 'string', enum: STAGES, description: '目标阶段。' },
        },
        required: ['stage'],
        additionalProperties: false,
      },
      output: output(),
      async execute(args, exec) {
        return foreman.withRoot(exec, () => foreman.setStage(args, exec));
      },
    },
  ];
}

export function createCommand(foreman) {
  return {
    name: 'foreman',
    description: '监工台：查看状态 / 恢复简报 / 任务卡',
    input: { hint: 'status | resume | card <id> | help' },
    async handler({ rawInput }) {
      const input = String(rawInput || '').trim();
      const [sub = 'status', ...rest] = input.split(/\s+/);
      try {
        if (sub === 'help') {
          return {
            kind: 'success',
            text: [
              '监工台命令：',
              '  /foreman            当前状态',
              '  /foreman resume     一页简报（新窗口恢复用）',
              '  /foreman card <id>  看某张任务卡',
              '  /foreman help       本帮助',
              '改状态请用工具 foreman_card / foreman_evidence / foreman_verdict。',
            ].join('\n'),
          };
        }
        if (sub === 'resume') {
          await foreman.ensureReady();
          await foreman.refreshBrief();
          return { kind: 'success', text: foreman.brief || '（暂无简报）' };
        }
        if (sub === 'card') {
          const id = rest[0];
          if (!id) return { kind: 'error', text: '用法：/foreman card <id>' };
          const snap = await foreman.snapshot();
          if (!snap.ok) return { kind: 'error', text: snap.error };
          const card = snap.cards.find((item) => item.id === id);
          if (!card) return { kind: 'error', text: `没有任务卡 ${id}。` };
          return { kind: 'success', text: JSON.stringify(card, null, 2) };
        }
        if (sub === 'status') {
          return { kind: 'success', text: await foreman.statusText() };
        }
        return { kind: 'error', text: `未知子命令：${sub}。用 /foreman help。` };
      } catch (error) {
        return { kind: 'error', text: error && error.message ? error.message : String(error) };
      }
    },
  };
}

export function createRoute(foreman) {
  return {
    kind: 'prefix',
    path: '/foreman/api',
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const send = (status, value) => {
        const body = JSON.stringify(value);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      };
      if (url.pathname !== '/foreman/api/snapshot' && url.pathname !== '/foreman/api/ping') {
        send(404, { ok: false, error: 'not found' });
        return;
      }
      if ((req.method || 'GET').toUpperCase() !== 'GET') {
        send(405, { ok: false, error: 'method not allowed' });
        return;
      }
      try {
        if (url.pathname === '/foreman/api/ping') {
          send(200, { ok: true, root: foreman.root || '' });
          return;
        }
        send(200, await foreman.snapshot());
      } catch (error) {
        send(500, { ok: false, error: error && error.message ? error.message : String(error) });
      }
    },
  };
}
