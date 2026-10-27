/**
 * 监工台的 Host 主体：状态机、任务卡、证据、裁决，以及给面板的只读快照。
 * 契约：模型只能"声称"，插件只做"记录"；真正不可伪造的判定留给 M2 的 gate 执行器。
 */
import { randomUUID } from 'node:crypto';
import {
  MAX_EVIDENCE,
  MAX_TAIL,
  appendDecision,
  cardSummary,
  decisionTail,
  dedupeFindings,
  dedupeP1,
  defaultState,
  emptyArchive,
  emptyChallenges,
  emptyEvidence,
  ensureSkeleton,
  fileDigest,
  listCards,
  normalizeCard,
  paths,
  readJson,
  readText,
  removeFile,
  resolveRoot,
  safeId,
  writeJson,
} from './store.mjs';
import { normalizeRoster, seatAgentId, seatName } from './roster.mjs';
import { renderBrief, stageLabel, writeBrief } from './brief.mjs';
import {
  findOpenChallenge,
  listChallenges,
  openChallenge,
  readChallengeStore,
  resolveChallenge,
  waiveChallenge,
} from './challenge.mjs';
import { projectSummary, validateProjectRoot } from './project.mjs';
import { createSeatGuard, foremanActionReason } from './guard.mjs';
import {
  listArchive,
  readArchiveStore,
  rememberArchive,
  resolveArchive,
  searchArchive,
  writeLessons,
} from './archive.mjs';
import {
  adjustReputation,
  breakersFrom,
  ensureReputation,
  listReputation,
  readReputation,
} from './reputation.mjs';
import {
  demoteSharedLesson,
  listSharedLessons,
  promoteSharedLesson,
  projectKey,
  resolveSharedLessonsPath,
} from './shared-lessons.mjs';
import { createCommand, createRoute, createTools } from './api.mjs';
import {
  DEFAULT_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  collectArtifacts,
  displayCommand,
  gateCwdIssue,
  gateSpecFromConfig,
  gateSpecHash,
  isPathInsideRoot,
  normalizeGateRegistry,
  normalizeProjectGateRegistry,
  resolveGateTimeout,
  runGateCommand,
  snapshotCode,
  snapshotTests,
} from './gate.mjs';

const SEAT_STATUS = ['idle', 'working', 'done', 'blocked'];
const STAGES = ['idle', 'meeting', 'implement', 'review', 'build', 'verify', 'accept', 'return'];

export class Foreman {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config || {};
    const shared = resolveSharedLessonsPath(this.config.sharedLessonsPath);
    this.sharedLessonsPath = shared.ok ? shared.path : null;
    this.sharedLessonsError = shared.ok ? '' : shared.error;
    this.root = resolveRoot(this.config.root);
    this.defaultRoot = this.root;
    this.lastRoot = this.root;
    this.agentRoots = new Map();
    this.rootStates = new Map();
    this.operationQueue = Promise.resolve();
    this.gateConfig = this.config.gates;
    this.gates = normalizeGateRegistry(this.root, this.gateConfig);
    this.gateInvalid = {};
    this.gateRegistryError = '';
    this.gateTimeoutMs = Number.isFinite(Number(this.config.gateTimeoutMs))
      ? Number(this.config.gateTimeoutMs) : DEFAULT_TIMEOUT_MS;
    this.gateGraceMs = Number.isFinite(Number(this.config.gateGraceMs))
      ? Number(this.config.gateGraceMs) : DEFAULT_GRACE_MS;
    this.gateQueue = Promise.resolve();
    this.goal = typeof this.config.goal === 'string' ? this.config.goal : '';
    this.configuredRoster = normalizeRoster(this.config.roster);
    this.roster = this.configuredRoster;
    this.agentPolicies = new Map();
    this.boundAgents = new Set();
    // M7.13：记录 agent/created 传来的真实 handle（带 ctx/tools），bind/rebind/claim 时用，
    // 不依赖 ctx.agents.list 是否返回同样对象。
    this.agentHandles = new Map();
    // M7.13：每席 filter 安装结果（installedAt/error），bind/rebind/claim 返回值与 snapshot 可观测。
    this.policyReport = new Map();

    // M7.12：记录曾在任一 agent schemas 中出现过的全局工具名（filter 安装前）。
    // builder 的 filter 重装时 schemas 已被自己的 deny 裁剪，不能据此推断 str_replace_editor 是否存在。
    this.knownToolNames = new Set();
    // M7.13：从 tools.restrict 的报错里解析出的真实全局工具注册表；
    // allow 列表必须与其求交，否则 agent 注入工具（subagent 等）会让 restrict 整条抛错。
    this.globalToolNames = new Set();
    this.policyListeners = [];
    this.policyDepth = 0;
    this.retiredAgents = new Set();
    this.bindingSessions = new Map();
    this.seatBindings = new Map();
    // M7.6：claim 属于"本次进程"的身份自注册；重启/重载后 epoch 变化，旧 claim 失效并回到 rebind-required。
    this.bindingEpoch = randomUUID();
    this.activeSessionKey = '';
    this.brief = '';
    this.globalBrief = '';
    this.readyPromise = null;
    this.lastError = '';
    this.rootStates.set(this.root, this.captureRootState());
  }

  /* ---------- per-agent root 运行时 ---------- */

  captureRootState() {
    return {
      root: this.root,
      gates: this.gates,
      gateInvalid: this.gateInvalid,
      gateRegistryError: this.gateRegistryError,
      gateProjectCount: this.gateProjectCount || 0,
      gateConfigCount: this.gateConfigCount || 0,
      roster: this.roster,
      brief: this.brief,
      readyPromise: this.readyPromise,
      lastError: this.lastError,
    };
  }

  syncRootState() {
    if (!this.root) return;
    this.rootStates.set(this.root, this.captureRootState());
    this.lastRoot = this.root;
  }

  /** M7.8：当前 root 的 gate registry = config fallback + .foreman/gates.json 覆盖。 */
  async readGateRegistry(root) {
    const configRegistry = normalizeGateRegistry(root, this.gateConfig);
    let raw = null;
    let error = '';
    try {
      raw = await readJson(paths(root).gates, null);
    } catch (cause) {
      error = `.foreman/gates.json 读取失败：${cause && cause.message ? cause.message : String(cause)}`;
      raw = null;
    }
    const project = normalizeProjectGateRegistry(root, raw);
    return {
      gates: { ...configRegistry, ...project.gates },
      invalid: project.invalid,
      error: error || project.error,
      projectCount: Object.keys(project.gates).length,
      configCount: Object.keys(configRegistry).length,
    };
  }

  /** 面板/状态用的 gate registry 摘要（当前 root）。 */
  gateRegistrySummary() {
    const summary = {};
    for (const spec of Object.values(this.gates || {})) {
      summary[spec.name] = {
        registry: spec.registry || 'config',
        root: spec.root || '',
        cwd: spec.cwd,
        cwdSpec: spec.cwdSpec,
        testsRoot: spec.testsRoot,
        allowOutsideRoot: spec.allowOutsideRoot === true,
        outsideRoot: spec.outsideRoot === true,
      };
    }
    return summary;
  }

  /**
   * 激活某个 root 时重新读取它的 gate registry：切 root 后不会沿用旧 root 的本地 gate。
   */
  async loadRootState(root) {
    let state = this.rootStates.get(root);
    if (!state) {
      state = {
        root,
        gates: normalizeGateRegistry(root, this.gateConfig),
        gateInvalid: {},
        gateRegistryError: '',
        roster: this.configuredRoster,
        brief: '',
        readyPromise: null,
        lastError: '',
      };
      this.rootStates.set(root, state);
    }
    const registry = await this.readGateRegistry(root);
    state.gates = registry.gates;
    state.gateInvalid = registry.invalid;
    state.gateRegistryError = registry.error;
    state.gateProjectCount = registry.projectCount;
    state.gateConfigCount = registry.configCount;
    this.root = state.root;
    this.gates = state.gates;
    this.gateInvalid = state.gateInvalid;
    this.gateRegistryError = state.gateRegistryError;
    this.gateProjectCount = state.gateProjectCount || 0;
    this.gateConfigCount = state.gateConfigCount || 0;
    this.roster = state.roster;
    this.brief = state.brief;
    this.readyPromise = state.readyPromise;
    this.lastError = state.lastError;
    this.lastRoot = root;
  }

  rootForExec(exec) {
    const key = this.sessionKeyOf(exec);
    return (key && this.agentRoots.get(key)) || this.defaultRoot;
  }

  sessionKeyOf(exec) {
    const raw = exec && exec.agent
      ? (exec.agent.id || exec.agent.sessionId || '')
      : '';
    return raw ? String(raw) : '';
  }

  withRoot(exec, fn) {
    const run = this.operationQueue.then(async () => {
      this.activeSessionKey = this.sessionKeyOf(exec);
      await this.loadRootState(this.rootForExec(exec));
      try {
        return await fn();
      } finally {
        this.syncRootState();
      }
    });
    this.operationQueue = run.catch(() => {});
    return run;
  }

  seatForAgent(agentId) {
    const id = agentId ? String(agentId) : '';
    if (!id) return null;
    if (this.retiredAgents.has(id)) return { id: 'retired', agentId: id };
    for (const state of this.rootStates.values()) {
      const seat = (state.roster || []).find((item) => item && item.agentId === id);
      if (seat) return seat;
    }
    return null;
  }

  /** M7.17：按席位 id 跨 rootStates 找当前有效 agentId（与 guard 的 seatForAgent 同源）。 */
  seatAgentAcrossRoots(seatId) {
    for (const state of this.rootStates.values()) {
      const seat = (state.roster || []).find((item) => item && item.id === seatId);
      if (seat && seat.agentId && !this.retiredAgents.has(seat.agentId)) return seat.agentId;
    }
    return seatAgentId(this.roster, seatId);
  }

  bindingsForRoot() {
    let bindings = this.seatBindings.get(this.root);
    if (!bindings) {
      bindings = new Map();
      this.seatBindings.set(this.root, bindings);
    }
    return bindings;
  }

  /**
   * M7.7：guard 与业务入口共用同一套 seat/action 白名单（双保险）。
   * 返回 null 表示允许；主持/未绑定调用者不受席位限制。
   */
  forbiddenForSeat(name, input, exec) {
    const by = exec && exec.agent ? String(exec.agent.id || exec.agent.sessionId || '') : '';
    if (!by) return null;
    const seat = this.seatForAgent(by);
    if (!seat) return null;
    if (seat.id === 'retired') {
      return '该 agentId 属于旧会话席位（retired），已失效；请当前会话重新 bind/claim 后再操作。';
    }
    return foremanActionReason(seat.id, name, input) || null;
  }

  /**
   * M7.10：binding 只有在“本进程 claim（epoch 匹配）”或“当前 host bind session 匹配”
   * 时才算有效。旧 epoch 的 claim / 旧 session 的 bind 都视为失效，否则部分旧 binding
   * 会让 claim 误判为“已绑定”，也会让 warning 漏报该席位。
   */
  bindingIsCurrent(binding) {
    if (!binding || !binding.agentId) return false;
    if (binding.claim === true) return binding.session === this.bindingEpoch;
    const boundSession = this.bindingSessions.get(this.root);
    return Boolean(boundSession) && binding.session === boundSession;
  }

  unboundSeatIds() {
    const bindings = this.bindingsForRoot();
    return this.roster
      .filter((seat) => {
        const binding = bindings.get(seat.id);
        return !seat.agentId
          || !binding
          || binding.agentId !== seat.agentId
          || this.retiredAgents.has(seat.agentId)
          || this.retiredAgents.has(binding.agentId)
          || !this.bindingIsCurrent(binding);
      })
      .map((seat) => seat.id);
  }

  /** 本进程内已 claim 的席位（claim=true 且 epoch 匹配当前进程）。 */
  claimedSeatIds() {
    const bindings = this.bindingsForRoot();
    return this.roster
      .filter((seat) => {
        const binding = bindings.get(seat.id);
        return Boolean(
          seat.agentId
          && binding
          && binding.claim === true
          && binding.session === this.bindingEpoch
          && binding.agentId === seat.agentId
          && !this.retiredAgents.has(seat.agentId),
        );
      })
      .map((seat) => seat.id);
  }

  /** 本进程内尚未 claim 的席位（重启/重载后旧 claim 全部失效）。 */
  unclaimedSeatIds() {
    const claimed = new Set(this.claimedSeatIds());
    return this.roster.filter((seat) => !claimed.has(seat.id)).map((seat) => seat.id);
  }

  allSeatsClaimed() {
    return this.roster.length > 0 && this.unclaimedSeatIds().length === 0;
  }

  bindingWarning() {
    const missing = this.unboundSeatIds();
    // M7.10：rebind-required 要优先且列出缺失席（含旧 claim 失效的席位），不能先报
    // “绑定不完整”而漏掉某席；完整性检查在 rebind 之外单独走。
    if (this.rebindRequired()) {
      const seats = missing.length ? missing : this.roster.map((seat) => seat.id);
      return `rebind-required：持久化绑定 session/Epoch 与当前会话不匹配；缺失席位：${seats.join(' / ')}；请五席分别 foreman_seat claim，或由主持 rebind`;
    }
    if (missing.length) {
      return `绑定不完整：${missing.join(' / ')} 未绑定/未 claim；需五席全部 bind 或 claim 后才算已绑定`;
    }
    if (this.allSeatsClaimed()) return '';
    const active = this.activeSessionKey;
    const activeSeat = active
      ? this.roster.find((seat) => seat.agentId === active)
      : null;
    if (activeSeat && !this.retiredAgents.has(active)) return '';
    const boundSession = this.bindingSessions.get(this.root);
    if (!boundSession) {
      return '当前会话未绑定：roster 是旧/静态配置；请用 foreman_seat bind/claim 重新绑定五席';
    }
    if (active && boundSession !== active) {
      return `当前会话未绑定：roster 属于 ${boundSession}；请用 foreman_seat bind/claim 重新绑定`;
    }
    return '';
  }

  rebindRequired() {
    const bindings = this.bindingsForRoot();
    // M7.10：旧进程 epoch 的 claim 已经失效。只要还有未 claim 齐的旧 claim，就必须进入
    // rebind-required；不能因为“还有席位没绑定”而提前 return false，否则首个 claim
    // 会被“已绑定”误拒，warning 也会漏掉这些席位。
    const hasStaleClaim = this.roster.some((seat) => {
      const binding = bindings.get(seat.id);
      return Boolean(binding && binding.claim === true && binding.session !== this.bindingEpoch);
    });
    if (hasStaleClaim && !this.allSeatsClaimed()) return true;
    if (bindings.size !== this.roster.length) return false;
    if (this.unboundSeatIds().length) return false;
    // 五席都在本进程 claim 齐 → 身份自注册本身即说明谁是当前席位，不再要求 host session 匹配。
    if (this.allSeatsClaimed()) return false;
    const boundSession = this.bindingSessions.get(this.root);
    if (!boundSession) return true;
    if (!this.activeSessionKey) return true;
    const activeSeat = this.roster.find((seat) => seat.agentId === this.activeSessionKey);
    if (activeSeat && bindings.get(activeSeat.id)?.agentId === this.activeSessionKey) return false;
    return boundSession !== this.activeSessionKey;
  }

  /* ---------- schema 级 toolFilter（M3.4） ---------- */

  coderChallengeDefinition() {
    const definition = createTools(this).find((tool) => tool.name === 'foreman_challenge');
    if (!definition) return null;
    const parameters = JSON.parse(JSON.stringify(definition.parameters));
    if (parameters && parameters.properties && parameters.properties.action) {
      parameters.properties.action.enum = ['open', 'list'];
    }
    return {
      ...definition,
      description: `${definition.description}（coder 仅 open/list；resolve 仅 Nitpicker）`,
      parameters,
    };
  }

  recordPolicyFailure(agentId, seatId, message) {
    // M7.14：非活跃/失效 agent 的重装失败不能覆盖之前的成功记录；
    // 只有从未成功安装过才记录失败，避免 status 被误读。
    const prior = this.policyReport.get(agentId);
    if (prior && prior.installedAt) return;
    this.policyReport.set(agentId, { seat: seatId, installedAt: 0, error: message });
  }

  installAgentPolicy(agent, force = false) {
    if (!agent) return null;
    const agentId = String(agent.id || agent.agentId || (agent.session && agent.session.id) || '');
    if (!agent.ctx || !agent.ctx.tools) {
      this.recordPolicyFailure(agentId, '', 'agent handle 无 ctx/tools');
      return null;
    }
    const existing = this.agentPolicies.get(agent);
    if (existing && !force) return existing;
    const seat = this.seatForAgent(agentId);
    if (!seat || seat.id === 'retired') {
      this.recordPolicyFailure(agentId, seat ? seat.id : '', 'agentId 未绑定席位');
      return null;
    }
    this.boundAgents.add(agent);
    let schemas = [];
    try {
      schemas = typeof agent.ctx.tools.schemas === 'function' ? agent.ctx.tools.schemas(agent) : [];
    } catch {
      schemas = [];
    }
    // M7.9：用插件自己的完整工具表补全 names。claim/工具刷新瞬间 agent 的 schemas 可能为空或
    // 已被旧 filter 裁剪，只看 schemas 会算不出 coder deny filter，导致 verdict/stage 短暂重现。
    const pluginNames = new Set(createTools(this).map((tool) => tool.name));
    const currentNames = new Set((schemas || []).map((schema) => schema && schema.name).filter(Boolean));
    const names = new Set([...currentNames, ...pluginNames]);
    if (!names.size) return existing || null;
    for (const name of names) this.knownToolNames.add(name);

    const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'read_image'];
    const BUILDER_WRITE_TOOLS = ['write', 'edit', 'str_replace_editor'];
    let filter = null;
    if (seat.id === 'reviewer' || seat.id === 'nitpicker' || seat.id === 'archivist') {
      const allow = [...new Set([
        ...READ_ONLY_TOOLS,
        ...[...names].filter((name) => name.startsWith('foreman_')),
      ])];
      filter = { allow };
    } else if (seat.id === 'builder') {
      // M7.13：builder 用 allow-list（当前可见工具减去写工具）而不是 deny。
      // live 实测 deny 对全局 write/edit 不生效（可能不在 agent 自身 scope 内），
      // 而 reviewer 的 allow-list 能隐藏全局工具，说明 allow 是可靠路径。
      const allow = [...names].filter((name) => !BUILDER_WRITE_TOOLS.includes(name));
      if (allow.length) {
        filter = { allow };
      } else {
        const builderDeny = BUILDER_WRITE_TOOLS.filter((name) => this.knownToolNames.has(name));
        filter = { deny: builderDeny.length ? builderDeny : ['write', 'edit'] };
      }
    } else if (seat.id === 'coder') {
      filter = { deny: ['foreman_verdict', 'foreman_stage'] };
    }

    const makeCoderChallenge = seat.id === 'coder' && names.has('foreman_challenge');
    if (!filter && !makeCoderChallenge) return existing || null;
    if (existing) {
      this.policyDepth += 1;
      try { existing(); } catch { /* 已释放 */ } finally { this.policyDepth -= 1; }
    }
    let effect;
    this.policyDepth += 1;
    try {
      effect = agent.ctx.effect(() => {
        const local = [];
        try {
          if (filter) {
            let applied = false;
            try {
              local.push(agent.ctx.tools.restrict(filter));
              applied = true;
            } catch (error) {
              const message = String((error && error.message) || error);
              const parsed = message.match(/known global tools:\s*([\s\S]*)$/);
              if (parsed) {
                for (const name of parsed[1].split(',')) {
                  const trimmed = name.trim();
                  if (trimmed) this.globalToolNames.add(trimmed);
                }
                // M7.13：真实 restrict 会因 agent 注入工具（subagent 等）不在全局注册表而整条抛错；
                // 用报错里的全局注册表把 allow 收窄后重试一次。
                const narrow = (candidate) => {
                  if (!candidate || !candidate.allow) return candidate;
                  const allow = candidate.allow.filter(
                    (name) => this.globalToolNames.has(name) || name.startsWith('foreman_'),
                  );
                  return allow.length ? { allow } : candidate;
                };
                try {
                  local.push(agent.ctx.tools.restrict(narrow(filter)));
                  applied = true;
                } catch (second) {
                  if (!applied) throw error;
                }
              }
              if (!applied) throw error;
            }
          }
          if (makeCoderChallenge) {
            const coderChallenge = this.coderChallengeDefinition();
            if (coderChallenge) local.push(agent.ctx.tools.register(coderChallenge));
          }
        } catch (error) {
          for (let index = local.length - 1; index >= 0; index -= 1) {
            try { local[index](); } catch { /* 已释放 */ }
          }
          throw error;
        }
        return () => {
          for (let index = local.length - 1; index >= 0; index -= 1) {
            try { local[index](); } catch { /* 已释放 */ }
          }
        };
      }, `foreman:toolFilter:${seat.id}`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.ctx.logger?.warn?.(`[foreman] install toolFilter for ${seat.id} failed: ${message}`);
      this.recordPolicyFailure(agentId, seat.id, message);
      return existing || null;
    } finally {
      this.policyDepth -= 1;
    }
    const dispose = () => {
      try { effect?.(); } catch { /* 已释放 */ }
      this.agentPolicies.delete(agent);
    };
    this.agentPolicies.set(agent, dispose);
    const report = this.policyReport.get(agentId) || {};
    this.policyReport.set(agentId, {
      seat: seat.id,
      mode: report.mode || (filter && filter.allow ? 'allow' : filter && filter.deny ? 'deny' : 'none'),
      installedAt: Date.now(),
      error: '',
    });
    return dispose;
  }

  refreshAgentPolicies() {
    if (this.policyDepth > 0) return;
    this.policyDepth += 1;
    try {
      const agents = new Set([...this.boundAgents, ...this.agentPolicies.keys(), ...this.agentHandles.values()]);
      if (this.ctx.agents && typeof this.ctx.agents.list === 'function') {
        for (const agent of this.ctx.agents.list()) agents.add(agent);
      }
      for (const agent of agents) {
        try { this.installAgentPolicy(agent, true); } catch { /* 不阻断工具注册 */ }
      }
    } finally {
      this.policyDepth -= 1;
    }
  }

  installLiveAgentPolicies() {
    if (!this.ctx || typeof this.ctx.on !== 'function') return;
    this.policyListeners = [];
    const onCreated = ({ agent }) => {
      if (agent) {
        const id = String(agent.id || agent.agentId || (agent.session && agent.session.id) || '');
        if (id) this.agentHandles.set(id, agent);
      }
      try { this.installAgentPolicy(agent); } catch { /* 不阻断 agent 创建 */ }
    };
    const onDisposed = ({ agent }) => {
      this.boundAgents.delete(agent);
      if (agent) {
        const id = String(agent.id || agent.agentId || (agent.session && agent.session.id) || '');
        if (id) this.agentHandles.delete(id);
      }
      const dispose = this.agentPolicies.get(agent);
      if (dispose) dispose();
    };
    const onToolsChange = () => {
      try { this.refreshAgentPolicies(); } catch { /* 不阻断工具注册 */ }
    };
    try {
      this.policyListeners.push(this.ctx.on('agent/created', onCreated));
      this.policyListeners.push(this.ctx.on('agent/disposed', onDisposed));
      this.policyListeners.push(this.ctx.on('tools/change', onToolsChange));
    } catch (error) {
      this.ctx.logger?.warn?.(`[foreman] agent lifecycle hooks unavailable: ${error && error.message ? error.message : String(error)}`);
      return;
    }
    if (this.ctx.agents && typeof this.ctx.agents.list === 'function') {
      try {
        for (const agent of this.ctx.agents.list()) {
          if (agent) {
            const id = String(agent.id || agent.agentId || (agent.session && agent.session.id) || '');
            if (id) this.agentHandles.set(id, agent);
          }
          try { this.installAgentPolicy(agent); } catch { /* 不阻断插件加载 */ }
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`[foreman] list agents for toolFilter failed: ${error && error.message ? error.message : String(error)}`);
      }
    }
  }

  /* ---------- 生命周期 ---------- */

  register() {
    const disposers = [];
    for (const tool of createTools(this)) disposers.push(this.ctx.tools.register(tool));
    if (typeof this.ctx.tools.guard === 'function') {
      disposers.push(this.ctx.tools.guard(createSeatGuard((agentId) => this.seatForAgent(agentId))));
    }
    try {
      this.installLiveAgentPolicies();
    } catch (error) {
      this.ctx.logger?.warn?.(`[foreman] install agent policies failed: ${error && error.message ? error.message : String(error)}`);
    }
    disposers.push(() => {
      for (const dispose of this.policyListeners) {
        try { dispose(); } catch { /* 已释放 */ }
      }
      this.policyListeners = [];
      for (const dispose of this.agentPolicies.values()) {
        try { dispose(); } catch { /* 已释放 */ }
      }
      this.agentPolicies.clear();
      this.boundAgents.clear();
    });
    disposers.push(this.ctx.commands.register(createCommand(this)));
    disposers.push(this.ctx.webServer.register(createRoute(this)));
    disposers.push(this.ctx.systemPrompt.section({
      name: 'foreman-brief',
      order: 640,
      text: () => this.globalBrief,
    }));
    return () => {
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try {
          disposers[index]();
        } catch {
          /* 已释放 */
        }
      }
    };
  }

  async bootstrap() {
    try {
      await this.ensureReady();
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
      if (error && error.code !== 'ENOENT') {
        // 目录不可写等问题不该拖垮宿主，面板会显示 lastError。
        console.warn('[foreman] bootstrap failed:', this.lastError);
      }
    }
  }

  async ensureReady() {
    if (!this.root) {
      throw new Error('监工台未配置项目目录：请在 cordis.patch.yml 的 foreman 行设置 config.root（绝对路径）。');
    }
    if (!this.readyPromise) this.readyPromise = this.init();
    return this.readyPromise;
  }

  async loadBindings() {
    const p = paths(this.root);
    const raw = await readJson(p.bindings, null);
    if (!raw || !raw.seatBindings || typeof raw.seatBindings !== 'object') return false;
    const bindings = new Map();
    let changed = false;
    for (const [seatId, value] of Object.entries(raw.seatBindings)) {
      if (!value || typeof value.agentId !== 'string' || !value.agentId) continue;
      const binding = {
        agentId: value.agentId,
        session: String(value.session || raw.bindingSession || 'host'),
        at: Number(value.at) || Date.now(),
      };
      if (value.claim === true) binding.claim = true;
      bindings.set(seatId, binding);
      this.agentRoots.set(binding.agentId, this.root);
      const seat = this.roster.find((item) => item.id === seatId);
      if (seat && seat.agentId !== binding.agentId) {
        seat.agentId = binding.agentId;
        changed = true;
      }
    }
    if (raw.bindingSession) this.bindingSessions.set(this.root, String(raw.bindingSession));
    if (raw.bindingSessions && typeof raw.bindingSessions === 'object') {
      for (const [root, session] of Object.entries(raw.bindingSessions)) {
        if (root && session) this.bindingSessions.set(root, String(session));
      }
    }
    if (bindings.size) this.seatBindings.set(this.root, bindings);
    if (Array.isArray(raw.retired)) {
      for (const id of raw.retired) if (id) this.retiredAgents.add(String(id));
    }
    if (bindings.size) {
      const state = await this.state();
      state.seats = state.seats || {};
      for (const [seatId, binding] of bindings.entries()) {
        state.seats[seatId] = {
          ...(state.seats[seatId] || {}),
          agentId: binding.agentId,
          at: state.seats[seatId]?.at || binding.at,
        };
      }
      state.updatedAt = Date.now();
      await writeJson(p.state, state);
      if (changed) await writeJson(p.roster, this.roster);
    }
    return bindings.size > 0;
  }

  async persistBindings() {
    const p = paths(this.root);
    const bindings = this.bindingsForRoot();
    const currentSession = this.bindingSessions.get(this.root) || null;
    // M7.9：bindings.json 只写当前 root 的 session 元数据，不把其他 root 的 session 带进来。
    const data = {
      version: 1,
      bindingSession: currentSession,
      bindingSessions: this.root && currentSession ? { [this.root]: currentSession } : {},
      seatBindings: Object.fromEntries([...bindings.entries()]),
      retired: [...this.retiredAgents],
    };
    await writeJson(p.bindings, data);
  }

  async init() {
    const skeleton = await ensureSkeleton(this.root, { goal: this.goal, roster: this.roster });
    if (Array.isArray(skeleton.roster) && skeleton.roster.length) this.roster = normalizeRoster(skeleton.roster);
    const registry = await this.readGateRegistry(this.root);
    this.gates = registry.gates;
    this.gateInvalid = registry.invalid;
    this.gateRegistryError = registry.error;
    this.gateProjectCount = registry.projectCount;
    this.gateConfigCount = registry.configCount;
    await this.loadBindings();
    this.syncRootState();
    await ensureReputation(this.root, this.roster);
    await this.refreshBrief();
    return this;
  }

  /* ---------- 读模型 ---------- */

  async model() {
    const p = paths(this.root);
    const state = (await readJson(p.state, null)) || defaultState(this.goal);
    const listed = await listCards(this.root);
    // M7.9：没有当前卡（state.cardId=null）就显示无当前卡，不回退到最近一张卡。
    const card = listed.currentId
      ? listed.cards.find((item) => item.id === listed.currentId) || null
      : null;
    const evidence = (await readJson(p.evidence, emptyEvidence())).entries || [];
    const challenges = await readChallengeStore(this.root);
    const archive = await readArchiveStore(this.root);
    const reputation = await readReputation(this.root, this.roster);
    let sharedLessons = [];
    let sharedLessonsError = this.sharedLessonsError;
    if (this.sharedLessonsPath) {
      try {
        sharedLessons = await listSharedLessons(this.sharedLessonsPath);
      } catch (error) {
        sharedLessonsError = error && error.message ? error.message : String(error);
      }
    }
    const decisions = await decisionTail(this.root, 6);
    return { state, cards: listed.cards, card, evidence, challenges, archive, reputation, sharedLessons, sharedLessonsError, decisions };
  }

  async snapshot() {
    if (!this.root) {
      return {
        ok: false,
        error: this.lastError || '未配置项目目录',
        root: '',
        goal: this.goal,
        roster: this.roster.map((seat) => ({ ...seat, status: 'idle', note: '' })),
        state: defaultState(this.goal),
        cards: [],
        card: null,
        evidence: [],
        challenges: [],
        openChallengeCount: 0,
        archive: [],
        openArchiveCount: 0,
        reputation: { seats: {} },
        breakers: [],
        sharedLessons: [],
        sharedLessonCount: 0,
        gateRegistry: {},
        gateRegistryError: '',
        invalidGates: {},
        bindingWarning: '',
        rebindRequired: false,
        unboundSeats: [],
        claimedSeats: [],
        unclaimedSeats: [],
        allSeatsClaimed: false,
        bindingSession: null,
        findings: { p0: [], p1: [] },
        decisions: '',
        brief: '',
      };
    }
    const { state, cards, card, evidence, challenges, archive, reputation, sharedLessons, sharedLessonsError, decisions } = await this.model();
    const gateEvidenceCount = evidence.filter((entry) => entry.source === 'gate').length;
    const reportedEvidenceCount = evidence.filter((entry) => entry.source === 'reported').length;
    const openChallengeCount = challenges.entries.filter((entry) => entry.status === 'open').length;
    const openArchiveCount = archive.entries.filter((entry) => entry.status === 'open').length;
    const breakers = breakersFrom(reputation, this.roster);
    const bindingWarning = this.bindingWarning();
    const rebindRequired = this.rebindRequired();
    const unboundSeats = this.unboundSeatIds();
    // 完整 bind 会话失配、但没有单席失效时，rebind-required 仍表示五席都要重新绑定；
    // 其余情况按实际未绑定/失效席位列，避免把本进程已 claim 的席位也算成缺失。
    const missingSeats = rebindRequired && unboundSeats.length === 0
      ? this.roster.map((seat) => seat.id)
      : unboundSeats;
    const claimedSeats = this.claimedSeatIds();
    const unclaimedSeats = this.unclaimedSeatIds();
    return {
      ok: true,
      root: this.root,
      goal: state.goal || this.goal,
      stage: state.stage,
      stageLabel: stageLabel(state.stage),
      state,
      cards,
      card,
      cardSummary: cardSummary(card),
      evidence: evidence.slice(-40).reverse(),
      evidenceCount: evidence.length,
      gateEvidenceCount,
      reportedEvidenceCount,
      evidenceBySource: { gate: gateEvidenceCount, reported: reportedEvidenceCount },
      challenges: challenges.entries,
      openChallengeCount,
      archive: archive.entries,
      openArchiveCount,
      sharedLessons,
      sharedLessonCount: sharedLessons.length,
      sharedLessonsError,
      gateRegistry: this.gateRegistrySummary(),
      gateRegistryError: this.gateRegistryError || '',
      invalidGates: { ...(this.gateInvalid || {}) },
      reputation: reputation.seats,
      breakers,
      bindingWarning,
      rebindRequired,
      unboundSeats: missingSeats,
      claimedSeats,
      unclaimedSeats,
      allSeatsClaimed: this.allSeatsClaimed(),
      bindingSession: this.bindingSessions.get(this.root) || null,
      policyReport: [...this.policyReport.entries()]
        .filter(([agentId]) => this.roster.some((seat) => seat.agentId === agentId))
        .map(([agentId, report]) => ({ agentId, ...report })),
      findings: { p0: state.p0 || [], p1: state.p1 || [] },
      roster: this.roster.map((seat) => ({
        id: seat.id,
        agentId: seat.agentId || (state.seats && state.seats[seat.id] && state.seats[seat.id].agentId) || null,
        name: seat.name,
        duty: seat.duty,
        prompt: seat.prompt,
        can: seat.can,
        status: (state.seats && state.seats[seat.id] && state.seats[seat.id].status) || 'idle',
        note: (state.seats && state.seats[seat.id] && state.seats[seat.id].note) || '',
      })),
      decisions,
      brief: this.brief || (await readText(paths(this.root).brief, '')),
      updatedAt: state.updatedAt,
      lastVerdict: state.lastVerdict && card && state.lastVerdict.cardId === card.id && state.lastVerdict.at >= card.createdAt ? state.lastVerdict : null,
    };
  }

  async refreshBrief() {
    const { state, card, evidence, challenges, archive, reputation, sharedLessons, decisions } = await this.model();
    const text = renderBrief({
      goal: state.goal || this.goal,
      state,
      card,
      evidence,
      challenges: challenges.entries,
      archive: archive.entries,
      reputation: reputation.seats,
      sharedLessons,
      bindingWarning: this.bindingWarning(),
      findings: { p0: state.p0 || [], p1: state.p1 || [] },
      decisions,
    });
    this.brief = text;
    if (this.root === this.defaultRoot) this.globalBrief = text;
    await writeBrief(paths(this.root).brief, text);
    return text;
  }

  /* ---------- 多项目 active root（M3.1） ---------- */

  async runProject(input, exec) {
    const action = String((input && input.action) || 'status').trim();
    if (action === 'status') {
      await this.ensureReady();
      const snap = await this.snapshot();
      return projectSummary(action, this.root, snap);
    }
    if (action !== 'use') return { ok: false, error: 'action 只能是 use / status。' };
    const raw = String((input && input.root) || '').trim();
    const validation = await validateProjectRoot(raw);
    if (!validation.ok) return validation;
    const next = validation.root;

    await this.gateQueue;
    const key = exec && exec.agent ? String(exec.agent.id || exec.agent.sessionId || '') : '';
    const previousRoot = this.root;
    const previousAgentRoot = key ? this.agentRoots.get(key) : this.defaultRoot;
    const previousState = this.captureRootState();
    this.syncRootState();
    if (key) this.agentRoots.set(key, next);
    else this.defaultRoot = next;
    await this.loadRootState(next);
    try {
      await this.ensureReady();
      const snap = await this.snapshot();
      return projectSummary(action, this.root, snap);
    } catch (error) {
      if (key) {
        if (previousAgentRoot) this.agentRoots.set(key, previousAgentRoot);
        else this.agentRoots.delete(key);
      } else {
        this.defaultRoot = previousRoot;
      }
      this.rootStates.set(previousRoot, previousState);
      await this.loadRootState(previousRoot);
      return { ok: false, error: `切换项目失败：${error && error.message ? error.message : String(error)}` };
    }
  }

  /* ---------- 任务卡 ---------- */

  async upsertCard(input, exec) {
    await this.ensureReady();
    const denied = this.forbiddenForSeat('foreman_card', input, exec);
    if (denied) return { ok: false, error: denied };
    const id = safeId(input && input.id);
    if (!id || id === 'unnamed') return { ok: false, error: '任务卡必须有 id，例如 A4。' };
    const allowed = normalizeAllowedFiles(input && input.allowedFiles);
    if (!allowed.ok) return allowed;
    const p = paths(this.root);
    const previous = await readJson(p.card(id), null);
    const next = normalizeCard(id, {
      scope: { do: input.scopeDo, not: input.scopeNot },
      acceptance: input.acceptance,
      gates: input.gates,
      artifacts: input.artifacts,
      allowedFiles: allowed.files,
      note: input.note,
    }, previous);
    const rebase = Boolean(input && input.rebaseManifest === true);
    if (rebase) {
      if (!next.freezeManifest) {
        return { ok: false, error: `任务卡 ${id} 尚未冻结，没有可重拍的基线；请先 freeze。` };
      }
    }
    if (previous && previous.frozen) {
      const before = JSON.stringify([previous.scope, previous.acceptance, previous.gates, previous.artifacts, previous.allowedFiles]);
      const after = JSON.stringify([next.scope, next.acceptance, next.gates, next.artifacts, next.allowedFiles]);
      if (before !== after) {
        if (!input.signedBy) {
          return { ok: false, error: `任务卡 ${id} 已冻结：改范围/验收/门禁/允许文件必须由主持签字（传 signedBy，可附 signNote）。` };
        }
        next.revise = (previous.revise || 0) + 1;
        next.frozenBy = String(input.signedBy);
        await appendDecision(this.root, {
          author: String(input.signedBy),
          text: `改契约 ${id}（rev ${next.revise}）：${input.signNote || '未写理由'}`,
        });
      }
    }
    if (rebase) {
      // M7.16：修订默认保留原基线；只有显式 rebaseManifest=true 才按当前文件树重拍。
      const snapshot = await snapshotCode(this.root);
      next.freezeManifest = { at: Date.now(), entries: snapshot.entries };
    }
    await writeJson(p.card(id), next);
    if (rebase) {
      await appendDecision(this.root, {
        author: String(input.signedBy || 'foreman'),
        text: `重拍基线 ${id}（${next.freezeManifest.entries.length} 文件）`,
      });
    }
    const state = await this.state();
    if (input.setCurrent !== false) {
      state.cardId = id;
      if (state.stage === 'idle' || state.stage === 'meeting') state.stage = 'implement';
    }
    state.updatedAt = Date.now();
    await writeJson(p.state, state);
    await this.refreshBrief();
    return { ok: true, card: next, current: state.cardId, stage: state.stage };
  }

  async freezeCard(input, exec) {
    await this.ensureReady();
    const denied = this.forbiddenForSeat('foreman_card', input, exec);
    if (denied) return { ok: false, error: denied };
    const id = safeId(input && input.id);
    if (!String(input.signedBy || '').trim()) return { ok: false, error: '冻结契约必须由主持签字：传 signedBy。' };
    const allowed = normalizeAllowedFiles(input && input.allowedFiles);
    if (!allowed.ok) return allowed;
    const p = paths(this.root);
    const card = await readJson(p.card(id), null);
    if (!card) return { ok: false, error: `任务卡 ${id} 不存在。` };
    if (allowed.files !== undefined) card.allowedFiles = allowed.files;
    const rebase = Boolean(input && input.rebaseManifest === true);
    if (!card.freezeManifest || rebase) {
      // M7.16：首次冻结/显式 rebase 才拍逐文件基线；普通重复 freeze 默认保留原锚点。
      let snapshot;
      try {
        snapshot = await snapshotCode(this.root);
      } catch (error) {
        return { ok: false, error: `冻结基线快照失败：${error && error.message ? error.message : String(error)}` };
      }
      card.freezeManifest = { at: Date.now(), entries: snapshot.entries };
    }
    card.frozen = true;
    card.frozenBy = String(input.signedBy);
    card.updatedAt = Date.now();
    await writeJson(p.card(id), card);
    await appendDecision(this.root, {
      author: String(input.signedBy),
      text: `冻结契约 ${id}：${input.signNote || cardSummary(card)}`,
    });
    await this.refreshBrief();
    return { ok: true, card };
  }

  async deleteCard(input, exec) {
    await this.ensureReady();
    const denied = this.forbiddenForSeat('foreman_card', input, exec);
    if (denied) return { ok: false, error: denied };
    const id = safeId(input && input.id);
    const p = paths(this.root);
    // 先确认卡存在：不存在时不要清理任何 store，避免误删孤儿数据。
    if (!(await readJson(p.card(id), null))) return { ok: false, error: `任务卡 ${id} 不存在。` };
    const removed = await removeFile(p.card(id));
    if (!removed) return { ok: false, error: `任务卡 ${id} 不存在。` };

    // M7.11：删卡级联清理该 cardId 的 evidence/challenges/archive，避免同名重建继承旧数据。
    // 只按 cardId 过滤，其他卡历史不受影响；decisions 审计保持追加不改写。
    const cleaned = { evidence: 0, challenges: 0, archive: 0 };
    const evidenceStore = await readJson(p.evidence, emptyEvidence());
    const evidenceEntries = Array.isArray(evidenceStore.entries) ? evidenceStore.entries : [];
    const keptEvidence = evidenceEntries.filter((entry) => entry && entry.cardId !== id);
    if (keptEvidence.length !== evidenceEntries.length) {
      cleaned.evidence = evidenceEntries.length - keptEvidence.length;
      evidenceStore.entries = keptEvidence;
      await writeJson(p.evidence, evidenceStore);
    }
    const challengeStore = await readJson(p.challenges, emptyChallenges());
    const challengeEntries = Array.isArray(challengeStore.entries) ? challengeStore.entries : [];
    const keptChallenges = challengeEntries.filter((entry) => entry && entry.cardId !== id);
    if (keptChallenges.length !== challengeEntries.length) {
      cleaned.challenges = challengeEntries.length - keptChallenges.length;
      challengeStore.entries = keptChallenges;
      await writeJson(p.challenges, challengeStore);
    }
    const archiveStore = await readJson(p.archive, emptyArchive());
    const archiveEntries = Array.isArray(archiveStore.entries) ? archiveStore.entries : [];
    const keptArchive = archiveEntries.filter((entry) => entry && entry.cardId !== id);
    if (keptArchive.length !== archiveEntries.length) {
      cleaned.archive = archiveEntries.length - keptArchive.length;
      archiveStore.entries = keptArchive;
      await writeJson(p.archive, archiveStore);
      // LESSONS.md 是 archive 的可读投影，删条目后同步重写，避免旧卡残影。
      await writeLessons(this.root, keptArchive);
    }

    const state = await this.state();
    if (state.cardId === id) {
      state.cardId = null;
      state.stage = 'idle';
      state.updatedAt = Date.now();
      await writeJson(p.state, state);
    }
    await appendDecision(this.root, { author: 'foreman', text: `删除契约 ${id}` });
    await this.refreshBrief();
    return { ok: true, deleted: id, cleaned, cardId: state.cardId || null, stage: state.stage };
  }

  /* ---------- 证据 ---------- */

  async addEvidence(input) {
    await this.ensureReady();
    const gate = String((input && input.gate) || '').trim();
    if (!gate) return { ok: false, error: '证据必须写明 gate（例如 tsc / vitest / build / shot）。' };
    const p = paths(this.root);
    const state = await this.state();
    const cardId = input.cardId ? safeId(input.cardId) : state.cardId;
    if (cardId && !(await readJson(p.card(cardId), null))) {
      return { ok: false, error: `任务卡 ${cardId} 不存在，先把契约建起来。` };
    }
    const files = [];
    for (const relative of input.files || []) {
      try {
        files.push(await fileDigest(this.root, String(relative)));
      } catch {
        return { ok: false, error: `证据文件不存在或不可读：${relative}（路径相对项目根目录）` };
      }
    }
    const store = await readJson(p.evidence, emptyEvidence());
    const exitCode = typeof input.exitCode === 'number' ? input.exitCode : Number.isFinite(Number(input.exitCode)) ? Number(input.exitCode) : null;
    const entry = {
      id: `E${store.next || 1}`,
      cardId: cardId || null,
      gate,
      cmd: String(input.cmd || ''),
      exitCode,
      source: 'reported',
      at: Date.now(),
      files,
      tail: truncate(input.output, MAX_TAIL),
      note: String(input.note || ''),
      by: input.by || null,
    };
    store.next = (store.next || 1) + 1;
    store.entries = [...(store.entries || []), entry].slice(-MAX_EVIDENCE);
    await writeJson(p.evidence, store);

    state.p0 = (state.p0 || []).filter((item) => !(item.cardId === cardId && item.gate === gate && item.source === 'reported'));
    state.p1 = (state.p1 || []).filter((item) => !(item.cardId === cardId && item.gate === gate && item.source === 'reported'));
    if (exitCode !== null && exitCode !== 0) {
      state.p0.push({ code: 'P0', text: `门禁 ${gate} 未通过（exit ${exitCode}）`, cardId, gate, source: 'reported', at: Date.now() });
    }
    state.updatedAt = Date.now();
    await writeJson(p.state, state);
    await this.refreshBrief();
    return { ok: true, entry, p0: state.p0 };
  }

  /* ---------- 门禁执行（M2） ---------- */

  async runGate(input, exec) {
    const run = this.gateQueue.then(() => this.runGateSerial(input, exec));
    this.gateQueue = run.catch(() => {});
    return run;
  }

  async runGateSerial(input, exec) {
    await this.ensureReady();
    const gate = String((input && input.gate) || '').trim();
    if (!gate) return { ok: false, error: '必须指定 gate 名称。' };
    const p = paths(this.root);
    const state = await this.state();
    const cardId = safeId((input && input.cardId) || state.cardId);
    const card = await readJson(p.card(cardId), null);
    if (!card) return { ok: false, error: `任务卡 ${cardId} 不存在，先把契约建起来。` };
    if (!Array.isArray(card.gates) || !card.gates.includes(gate)) {
      return { ok: false, error: `gate ${gate} 不在任务卡 ${cardId} 的 gates 中，拒绝执行。` };
    }
    const spec = gateSpecFromConfig(this.gates, gate);
    if (!spec) {
      const invalid = this.gateInvalid && this.gateInvalid[gate];
      if (invalid) {
        return {
          ok: false,
          error: `gate ${gate} 在当前 root 的 .foreman/gates.json 中定义无效：${invalid}`,
          root: this.root,
          registry: 'project',
          invalid: true,
          available: Object.keys(this.gates),
        };
      }
      return {
        ok: false,
        error: `当前 root 未注册 gate ${gate}：.foreman/gates.json 与 config.gates 都没有它；不会沿用其他 root 或旧 registry。`,
        root: this.root,
        registry: 'none',
        registryError: this.gateRegistryError || '',
        available: Object.keys(this.gates),
      };
    }
    const cwdIssue = gateCwdIssue(spec, this.root);
    if (cwdIssue) {
      return {
        ok: false,
        error: cwdIssue.error,
        gate,
        cardId,
        root: cwdIssue.root || this.root,
        cwd: cwdIssue.cwd || spec.cwd,
        outsideRoot: true,
        allowOutsideRoot: false,
        registry: spec.registry || 'config',
        blocked: 'gate-cwd-outside-root',
        available: Object.keys(this.gates),
      };
    }
    const timeoutMs = resolveGateTimeout(spec, input && input.timeoutMs);
    if (timeoutMs === null) return { ok: false, error: 'timeoutMs 必须是正数。' };

    let before;
    let codeBefore;
    try {
      before = await snapshotTests(spec.cwd, spec.testsRoot);
      codeBefore = await snapshotCode(spec.cwd);
    } catch (error) {
      const message = `testsRoot/code 快照失败：${error && error.message ? error.message : String(error)}`;
      state.p0 = (state.p0 || []).filter((item) => !(item.cardId === cardId && item.gate === gate));
      state.p0.push({ code: 'P0', text: message, cardId, gate, source: 'gate', at: Date.now() });
      state.updatedAt = Date.now();
      await writeJson(p.state, state);
      await this.refreshBrief();
      return { ok: false, error: message, cardId, gate, p0: state.p0 };
    }

    const result = await runGateCommand(this.ctx.subprocess, spec, {
      timeoutMs,
      graceMs: Math.min(Number(spec.graceMs) || this.gateGraceMs, this.gateGraceMs),
    });

    let after;
    let codeAfter;
    let snapshotError = '';
    let codeError = '';
    try {
      after = await snapshotTests(spec.cwd, spec.testsRoot);
      codeAfter = await snapshotCode(spec.cwd);
    } catch (error) {
      after = { hash: 'snapshot-error', files: [] };
      codeAfter = { hash: 'code-snapshot-error', files: 0 };
      snapshotError = error && error.message ? error.message : String(error);
      codeError = snapshotError;
    }
    const testsChanged = before.hash !== after.hash;
    const codeChanged = codeBefore.hash !== codeAfter.hash || Boolean(codeError);
    const tampered = testsChanged || codeChanged;
    const diffEntries = (beforeList, afterList) => {
      const toMap = (list) => new Map((list || []).map((item) => [item.path, item.sha256]));
      const beforeMap = toMap(beforeList);
      const afterMap = toMap(afterList);
      const changed = new Set();
      for (const [path, hash] of afterMap) {
        if (!beforeMap.has(path) || beforeMap.get(path) !== hash) changed.add(path);
      }
      for (const path of beforeMap.keys()) {
        if (!afterMap.has(path)) changed.add(path);
      }
      return [...changed].sort();
    };
    const testsChangedFiles = diffEntries(before.files || [], after.files || []);
    const codeChangedFiles = diffEntries(codeBefore.entries || [], codeAfter.entries || []);
    const changedFiles = [...new Set([...codeChangedFiles, ...testsChangedFiles])].sort();

    // M7.18：gate 产物收集（不匹配/不存在不报错）
    const artifactFiles = await collectArtifacts(this.root, spec.cwd, spec.artifacts);

    const passed = result.exitCode === 0 && !result.timedOut && !tampered && !result.error;
    const id = `E${(await readJson(p.evidence, emptyEvidence())).next || 1}`;
    const outsideRoot = !isPathInsideRoot(this.root, spec.cwd);
    const entry = {
      id,
      cardId,
      gate,
      cmd: displayCommand(spec.argv),
      argv: [...spec.argv],
      root: this.root,
      registry: spec.registry || 'config',
      cwd: spec.cwd,
      cwdSpec: spec.cwdSpec,
      outsideRoot,
      allowOutsideRoot: spec.allowOutsideRoot === true,
      exitCode: result.exitCode,
      source: 'gate',
      at: Date.now(),
      files: artifactFiles,
      artifacts: [...(spec.artifacts || [])],
      durationMs: result.durationMs,
      tampered,
      timedOut: result.timedOut,
      tail: result.tail || '',
      stdoutTail: result.stdoutTail || '',
      stderrTail: result.stderrTail || '',
      testsHashBefore: before.hash,
      testsHashAfter: after.hash,
      codeHash: codeAfter.hash,
      codeHashBefore: codeBefore.hash,
      codeHashAfter: codeAfter.hash,
      specHash: gateSpecHash(spec),
      testsRoot: spec.testsRoot,
      testsDir: before.testsDir || after.testsDir || '',
      testsFiles: (after.files || []).map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
      codeFiles: (codeAfter.entries || []).map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
      changedFiles,
      note: snapshotError ? `snapshot: ${snapshotError}` : (codeError ? `code snapshot: ${codeError}` : ''),
      by: exec && exec.agent ? exec.agent.id : null,
    };
    const store = await readJson(p.evidence, emptyEvidence());
    entry.id = `E${store.next || 1}`;
    store.next = (store.next || 1) + 1;
    store.entries = [...(store.entries || []), entry].slice(-MAX_EVIDENCE);
    await writeJson(p.evidence, store);

    state.p0 = (state.p0 || []).filter((item) => !(item.cardId === cardId && item.gate === gate));
    const failures = [];
    if (result.timedOut) {
      failures.push({ code: 'P0', text: `门禁 ${gate} 超时（${timeoutMs}ms）`, cardId, gate, source: 'gate', at: Date.now() });
    } else if (result.exitCode !== 0) {
      failures.push({
        code: 'P0',
        text: `门禁 ${gate} 未通过（exit ${result.exitCode === null ? 'null' : result.exitCode}）`,
        cardId,
        gate,
        source: 'gate',
        at: Date.now(),
      });
    } else if (result.error) {
      failures.push({ code: 'P0', text: `门禁 ${gate} 执行失败：${result.error}`, cardId, gate, source: 'gate', at: Date.now() });
    }
    if (snapshotError) {
      failures.push({
        code: 'P0',
        text: `门禁 ${gate} testsRoot 快照失败：${snapshotError}`,
        cardId,
        gate,
        source: 'gate',
        at: Date.now(),
      });
    }
    if (testsChanged) {
      failures.push({
        code: 'P0',
        text: `门禁 ${gate} 期间 ${spec.testsRoot} 被修改（tampered）`,
        cardId,
        gate,
        source: 'gate',
        at: Date.now(),
      });
    }
    if (codeChanged) {
      failures.push({
        code: 'P0',
        text: `门禁 ${gate} 期间源码/配置摘要变化（tampered）`,
        cardId,
        gate,
        source: 'gate',
        at: Date.now(),
      });
    }
    state.p0.push(...failures);
    state.updatedAt = Date.now();
    await writeJson(p.state, state);
    await this.refreshBrief();
    return {
      ok: true,
      gate,
      cardId,
      passed,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      tampered,
      argv: spec.argv,
      root: this.root,
      registry: spec.registry || 'config',
      cwd: spec.cwd,
      cwdSpec: spec.cwdSpec,
      outsideRoot,
      allowOutsideRoot: spec.allowOutsideRoot === true,
      testsRoot: spec.testsRoot,
      testsDir: before.testsDir || after.testsDir || '',
      tail: result.tail || '',
      entry,
      p0: state.p0,
      failures,
    };
  }

  /* ---------- Nitpicker 挑战（M3） ---------- */

  async runChallenge(input, exec) {
    await this.ensureReady();
    const action = String((input && input.action) || '').trim();
    const denied = this.forbiddenForSeat('foreman_challenge', input, exec);
    if (denied) return { ok: false, error: denied };
    const state = await this.state();
    const cardId = input && input.cardId ? safeId(input.cardId) : (state.cardId ? safeId(state.cardId) : null);
    const by = exec && exec.agent ? exec.agent.id : null;
    const callerSeat = by ? this.seatForAgent(by) : null;
    if (action === 'list') {
      const result = await listChallenges(this.root, cardId || undefined);
      await this.refreshBrief();
      return { ok: true, action, cardId, ...result };
    }
    if (!cardId) return { ok: false, error: '挑战必须指定卡或先设当前卡。' };
    const card = await readJson(paths(this.root).card(cardId), null);
    if (!card) return { ok: false, error: `任务卡 ${cardId} 不存在。` };
    if (action === 'open') {
      const result = await openChallenge(this.root, {
        cardId,
        by,
        note: input && input.note,
        assignedSeat: 'nitpicker',
      });
      await this.refreshBrief();
      return { ok: true, action, cardId, ...result };
    }
    if (action === 'resolve') {
      if (!callerSeat || callerSeat.id !== 'nitpicker') {
        return {
          ok: false,
          error: callerSeat && callerSeat.id === 'retired'
            ? '旧会话 Nitpicker agentId 已失效；请当前会话先 foreman_seat bind nitpicker。'
            : '只有 Nitpicker（当前绑定）可以 resolve challenge。',
          nitpickerId: this.seatAgentAcrossRoots('nitpicker'),
        };
      }
      const store = await readChallengeStore(this.root);
      const open = findOpenChallenge(store, cardId);
      if (open && open.assignedSeat && open.assignedSeat !== 'nitpicker') {
        return { ok: false, error: `挑战 ${open.id} 的 assignedSeat 不是 nitpicker。` };
      }
      const result = await resolveChallenge(this.root, {
        cardId,
        decision: String((input && input.decision) || '').trim(),
        by,
        note: input && input.note,
      });
      await this.refreshBrief();
      return { ...result, action, cardId };
    }
    if (action === 'waive' || action === 'cancel') {
      if (callerSeat) {
        return { ok: false, error: '只有主持/未绑定调用者可以 waive/cancel challenge。' };
      }
      const result = await waiveChallenge(this.root, {
        cardId,
        by: by || 'host',
        reason: input && input.reason,
        evidence: input && input.evidence,
        note: input && input.note,
      });
      if (result.ok) await this.refreshBrief();
      return { ...result, action, cardId };
    }
    return { ok: false, error: 'action 只能是 open / resolve / list / waive / cancel。' };
  }

  /* ---------- 信誉账本（M5） ---------- */

  async runReputation(input, exec) {
    await this.ensureReady();
    const denied = this.forbiddenForSeat('foreman_reputation', input, exec);
    if (denied) return { ok: false, error: denied };
    const action = String((input && input.action) || '').trim();
    const by = exec && exec.agent ? exec.agent.id : null;
    if (action === 'status') {
      const result = await listReputation(this.root, this.roster);
      return { ok: true, action, ...result, breakers: breakersFrom(await readReputation(this.root, this.roster), this.roster) };
    }
    if (action === 'list') {
      const result = await listReputation(this.root, this.roster, input && input.seat ? String(input.seat) : undefined);
      return { ok: true, action, ...result };
    }
    if (action !== 'award' && action !== 'penalize') {
      return { ok: false, error: 'action 只能是 status / award / penalize / list。' };
    }
    const boundSeat = by ? this.seatForAgent(by) : null;
    if (boundSeat) {
      return {
        ok: false,
        error: `${boundSeat.id} 不能修改信誉分：只有未绑定主持可以 award/penalize；archivist 只读。`,
      };
    }
    const state = await this.state();
    const result = await adjustReputation(this.root, this.roster, {
      seat: input && input.seat,
      type: action,
      delta: input && input.delta,
      reason: input && input.reason,
      evidence: input && input.evidence,
      cardId: (input && input.cardId) || state.cardId || null,
      by,
    });
    if (!result.ok) return result;
    await this.refreshBrief();
    return { ok: true, action, ...result };
  }

  /* ---------- Archivist 归档（M4） ---------- */

  async runArchive(input, exec) {
    await this.ensureReady();
    const denied = this.forbiddenForSeat('foreman_archive', input, exec);
    if (denied) return { ok: false, error: denied };
    const action = String((input && input.action) || '').trim();
    const scope = String((input && input.scope) || 'project').trim();
    if (!['project', 'global', 'both'].includes(scope)) {
      return { ok: false, error: 'scope 只能是 project / global / both。' };
    }
    const state = await this.state();
    const p = paths(this.root);
    const cardId = input && input.cardId ? safeId(input.cardId) : (state.cardId ? safeId(state.cardId) : null);
    const by = exec && exec.agent ? exec.agent.id : null;
    const globalReady = () => {
      if (!this.sharedLessonsPath) return { ok: false, error: this.sharedLessonsError || 'sharedLessonsPath 不可用。' };
      return null;
    };
    const boundSeat = by ? this.seatForAgent(by) : null;
    const canGlobal = !boundSeat || boundSeat.id === 'archivist';
    if (action === 'promote') {
      if (!canGlobal) return { ok: false, error: '只有 archivist 或主持（未绑定 agent）可以 promote 到公共经验。' };
      const invalid = globalReady();
      if (invalid) return invalid;
      const archive = await readArchiveStore(this.root);
      const sourceId = input && input.id ? String(input.id) : '';
      const source = sourceId
        ? archive.entries.find((entry) => entry.id === sourceId)
        : archive.entries.find((entry) => entry.cardId === cardId && entry.fingerprint === String((input && input.fingerprint) || ''));
      if (!source) return { ok: false, error: '项目归档条目不存在。' };
      const result = await promoteSharedLesson(this.sharedLessonsPath, {
        archive: { ...archive, cardId },
        archiveId: source.id,
        cardId,
        fingerprint: source.fingerprint,
        root: this.root,
      });
      if (result.ok) await this.refreshBrief();
      return { ok: true, action, ...result, scope: 'global' };
    }
    if (action === 'demote') {
      if (!canGlobal) return { ok: false, error: '只有 archivist 或主持（未绑定 agent）可以 demote 公共经验。' };
      const invalid = globalReady();
      if (invalid) return invalid;
      const result = await demoteSharedLesson(this.sharedLessonsPath, {
        id: input && input.id,
        fingerprint: input && input.fingerprint,
      });
      if (result.ok) await this.refreshBrief();
      return { ok: true, action, ...result, scope: 'global' };
    }
    if (action === 'remember') {
      if (scope !== 'project') return { ok: false, error: 'remember 只写项目 archive；跨项目请用 promote。' };
      if (!cardId) return { ok: false, error: 'remember 必须指定卡或先设当前卡。' };
      if (!(await readJson(p.card(cardId), null))) return { ok: false, error: `任务卡 ${cardId} 不存在。` };
      const result = await rememberArchive(this.root, {
        cardId,
        fingerprint: input && input.fingerprint,
        area: input && input.area,
        symptom: input && input.symptom,
        repro: input && input.repro,
        rootCause: input && input.rootCause,
        fix: input && input.fix,
        regressionGuard: input && input.regressionGuard,
      });
      if (!result.ok) return result;
      state.p0 = (state.p0 || []).filter((item) => !(item.cardId === cardId && item.archiveId === result.entry.id));
      if (result.recurrence) {
        state.p0.push({
          code: 'P0',
          text: `归档复发 ${result.entry.id}（${result.entry.fingerprint}）`,
          cardId,
          archiveId: result.entry.id,
          fingerprint: result.entry.fingerprint,
          source: 'archive',
          at: Date.now(),
        });
        state.updatedAt = Date.now();
        await writeJson(p.state, state);
      }
      await this.refreshBrief();
      return { ok: true, action, scope, cardId, ...result, p0: state.p0 };
    }
    if (action === 'resolve') {
      if (scope !== 'project') return { ok: false, error: 'resolve 只作用于项目 archive。' };
      const archivistId = this.seatAgentAcrossRoots('archivist');
      if (boundSeat && boundSeat.id !== 'archivist') {
        return { ok: false, error: '只有 archivist 或主持（未绑定 agent）可以 resolve 归档。', archivistId };
      }
      const result = await resolveArchive(this.root, {
        id: input && input.id,
        cardId,
        fingerprint: input && input.fingerprint,
        status: input && input.status,
        by,
        regressionGuard: input && input.regressionGuard,
        fix: input && input.fix,
        rootCause: input && input.rootCause,
      });
      if (!result.ok) return result;
      state.p0 = (state.p0 || []).filter((item) => !(
        item.cardId === result.entry.cardId
        && (item.archiveId === result.entry.id || item.fingerprint === result.entry.fingerprint)
      ));
      state.updatedAt = Date.now();
      await writeJson(p.state, state);
      await this.refreshBrief();
      return { ok: true, action, scope, ...result, p0: state.p0 };
    }
    if (action === 'search') {
      const result = await searchArchive(this.root, {
        fingerprint: input && input.fingerprint,
        area: input && input.area,
        cardId,
      });
      if (scope === 'project') return { ok: true, action, scope, cardId, ...result };
      const invalid = globalReady();
      if (invalid) return invalid;
      const fp = String((input && input.fingerprint) || '').toLowerCase();
      const areaText = String((input && input.area) || '').toLowerCase();
      const globalLessons = (await listSharedLessons(this.sharedLessonsPath)).filter((lesson) => (
        (!fp || `${lesson.fingerprint} ${lesson.pattern || ''}`.toLowerCase().includes(fp))
        && (!areaText || String(lesson.area || '').toLowerCase().includes(areaText))
      ));
      if (scope === 'global') return { ok: true, action, scope, entries: globalLessons };
      return { ok: true, action, scope, cardId, entries: [...result.entries, ...globalLessons], projectEntries: result.entries, globalLessons };
    }
    if (action === 'list') {
      const result = await listArchive(this.root, {
        cardId,
        status: input && input.status ? String(input.status) : 'open',
      });
      if (scope === 'project') return { ok: true, action, scope, cardId, ...result };
      const invalid = globalReady();
      if (invalid) return invalid;
      const globalLessons = await listSharedLessons(this.sharedLessonsPath);
      if (scope === 'global') return { ok: true, action, scope, globalLessons };
      return { ok: true, action, scope, cardId, ...result, projectEntries: result.entries, globalLessons, entries: [...result.entries, ...globalLessons] };
    }
    return { ok: false, error: 'action 只能是 remember / search / list / resolve / promote / demote。' };
  }

  /* ---------- 裁决 ---------- */

  async recordVerdict(input, exec) {
    await this.ensureReady();
    const denied = this.forbiddenForSeat('foreman_verdict', input, exec);
    if (denied) return { ok: false, error: denied };
    const p = paths(this.root);
    const state = await this.state();
    const cardId = safeId((input && input.cardId) || state.cardId);
    const card = await readJson(p.card(cardId), null);
    if (!card) return { ok: false, error: `任务卡 ${cardId} 不存在。` };
    const verdict = String((input && input.verdict) || '').toUpperCase();
    if (verdict !== 'ACCEPT' && verdict !== 'RETURN') return { ok: false, error: 'verdict 只能是 ACCEPT 或 RETURN。' };

    const by = (exec && exec.agent && exec.agent.id) || input.by || 'unknown';
    if (verdict === 'ACCEPT') {
      // M7.16：先做冻结基线比对，任何越界变更都直接拒绝且不写 verdict。
      const manifestCheck = await this.checkFreezeManifest(card);
      if (!manifestCheck.ok) return manifestCheck;
      const challengeStore = await readChallengeStore(this.root);
      const open = findOpenChallenge(challengeStore, cardId);
      if (open) {
        return {
          ok: false,
          error: `任务卡 ${cardId} 有 open challenge ${open.id}，必须等 Nitpicker resolve 后才能 ACCEPT。`,
          challengeOpen: true,
          challenge: open,
        };
      }
      const cardChallenges = (challengeStore.entries || []).filter((entry) => entry.cardId === cardId);
      const latestChallenge = cardChallenges[cardChallenges.length - 1];
      if (latestChallenge && (latestChallenge.status === 'blocked' || latestChallenge.decision === 'blocked')) {
        return {
          ok: false,
          error: `任务卡 ${cardId} 最新 challenge ${latestChallenge.id} 是 blocked，必须先重新 open 并由 Nitpicker resolve cleared 才能 ACCEPT。`,
          challengeBlocked: true,
          challenge: latestChallenge,
        };
      }
      // M7.17：Reviewer 身份与 guard 同源（跨 rootStates），不再用当前 root 的本地 roster；
      // 否则在未 bind 的测试 root 里 Reviewer 首次 ACCEPT 会跳过自动开挑战直接放行。
      const callerSeat = by ? this.seatForAgent(by) : null;
      if (callerSeat && callerSeat.id === 'reviewer' && cardChallenges.length === 0) {
        const opened = await openChallenge(this.root, {
          cardId,
          by,
          note: 'Reviewer 提交 ACCEPT，自动开启 Nitpicker 挑战',
        });
        await this.refreshBrief();
        return {
          ok: false,
          error: `ACCEPT 已受理，已自动开启 challenge ${opened.challenge.id}；等 Nitpicker resolve 后再 ACCEPT。`,
          challengeOpened: true,
          challenge: opened.challenge,
        };
      }
      const archiveStore = await readArchiveStore(this.root);
      const openArchives = archiveStore.entries.filter((entry) => entry.cardId === cardId && entry.status === 'open');
      if (openArchives.length) {
        return {
          ok: false,
          error: `任务卡 ${cardId} 有 open 归档（${openArchives.map((entry) => entry.id).join('、')}），必须先 resolve fixed/wontfix 才能 ACCEPT。`,
          archiveOpen: true,
          archive: openArchives,
        };
      }
      const reputation = await readReputation(this.root, this.roster);
      const breakers = breakersFrom(reputation, this.roster);
      if (breakers.length) {
        return {
          ok: false,
          error: `信誉熔断：${breakers.map((item) => `${item.seat}=${item.score}`).join('、')}；先修复/申诉并调整信誉后再 ACCEPT。`,
          breakers,
        };
      }
    }
    const verdictP0 = (input.p0 || []).map((item) => (
      typeof item === 'string' ? { code: 'P0', text: item, cardId } : { ...item, cardId }
    ));
    const verdictP1 = (input.p1 || []).map((item) => (
      typeof item === 'string' ? { code: 'P1', text: item, cardId } : { ...item, cardId }
    ));
    state.p0 = dedupeFindings([...(state.p0 || []), ...verdictP0]);
    state.p1 = dedupeP1([...(state.p1 || []), ...verdictP1]);

    if (verdict === 'ACCEPT') {
      if ((state.p0 || []).length) {
        await writeJson(p.state, state);
        return {
          ok: false,
          error: `P0 未清零（${state.p0.length} 条），不能 ACCEPT。`,
          p0: state.p0,
        };
      }
      const missing = await this.missingGates(cardId, card);
      if (missing.length) {
        await writeJson(p.state, state);
        return {
          ok: false,
          error: `门禁证据缺失或未通过：${missing.join('、')}。先让 Builder 出证据，再签字。`,
          missing,
        };
      }
    }

    const summary = String((input && input.summary) || (verdict === 'ACCEPT' ? '通过' : '退回')).trim();
    card.status = verdict === 'ACCEPT' ? 'accepted' : 'returned';
    card.updatedAt = Date.now();
    await writeJson(p.card(cardId), card);

    state.stage = verdict === 'ACCEPT' ? 'accept' : 'return';
    state.lastVerdict = { verdict, summary, by, at: Date.now(), cardId };
    state.updatedAt = Date.now();
    await writeJson(p.state, state);

    const lines = [`裁决 ${cardId}：${verdict} — ${summary}`];
    if ((input.p0 || []).length) lines.push(`P0：${input.p0.join('；')}`);
    if ((input.p1 || []).length) lines.push(`P1：${input.p1.join('；')}`);
    if ((input.p2 || []).length) lines.push(`P2：${input.p2.join('；')}`);
    await appendDecision(this.root, { author: `foreman:${verdict}`, text: lines.join('\n') });
    await this.refreshBrief();
    return { ok: true, verdict, cardId, stage: state.stage, p0: state.p0, p1: state.p1 };
  }

  async missingGates(cardId, card) {
    const gates = (card && card.gates) || [];
    if (!gates.length) return [];
    const store = await readJson(paths(this.root).evidence, emptyEvidence());
    const entries = (store.entries || []).filter((entry) => entry.cardId === cardId);
    const missing = [];
    for (const gate of gates) {
      const spec = gateSpecFromConfig(this.gates, gate);
      if (!spec) {
        missing.push(gate);
        continue;
      }
      if (gateCwdIssue(spec, this.root)) {
        // 当前 root 下该 gate 的 cwd 越界且未显式 allowOutsideRoot：不能拿它当通过。
        missing.push(gate);
        continue;
      }
      const latest = [...entries].reverse().find((entry) => entry.gate === gate && entry.source === 'gate');
      if (!latest) {
        missing.push(gate);
        continue;
      }
      if (latest.root !== this.root) {
        // 证据必须属于当前 root；旧版本/旧 root 的证据不放行。
        missing.push(gate);
        continue;
      }
      let currentCode;
      let currentTests;
      try {
        currentCode = await snapshotCode(spec.cwd);
        currentTests = await snapshotTests(spec.cwd, spec.testsRoot);
      } catch {
        missing.push(gate);
        continue;
      }
      const passed = latest.exitCode === 0
        && latest.tampered !== true
        && latest.timedOut !== true
        && latest.codeHash === currentCode.hash
        && latest.testsHashAfter === currentTests.hash
        && latest.specHash === gateSpecHash(spec);
      if (!passed) missing.push(gate);
    }
    return missing;
  }

  /**
   * M7.16：冻结基线比对。只有 card.freezeManifest 存在且 allowedFiles 已定义（含空数组）时启用。
   * 返回 changed（新增/删除/内容变化）与 disallowed（不在 allowedFiles 内）。
   */
  async checkFreezeManifest(card) {
    const manifest = card && card.freezeManifest;
    const allowedFiles = card && card.allowedFiles;
    if (!manifest || !Array.isArray(manifest.entries) || !Array.isArray(allowedFiles)) {
      return { ok: true, skipped: true };
    }
    let current;
    try {
      current = await snapshotCode(this.root);
    } catch (error) {
      return {
        ok: false,
        error: `冻结基线比对失败：${error && error.message ? error.message : String(error)}`,
        baselineError: true,
      };
    }
    const changed = manifestChangedPaths(manifest.entries, current.entries);
    const disallowed = changed.filter((path) => !isAllowedManifestPath(path, allowedFiles));
    if (!disallowed.length) return { ok: true, changed, disallowed };
    const allowedText = allowedFiles.length ? allowedFiles.join('、') : '（空数组）';
    return {
      ok: false,
      error: `任务卡 ${card.id || '?'} 相对冻结基线有未允许的文件变更：${disallowed.join('、')}。allowedFiles：${allowedText}。如确需变更，请主持 rebaseManifest 或修订契约。`,
      changed,
      disallowed,
    };
  }

  /* ---------- 席位与阶段 ---------- */

  async rebindSeats(input, exec) {
    const by = exec && exec.agent ? String(exec.agent.id || exec.agent.sessionId || '') : '';
    const callerSeat = by ? this.seatForAgent(by) : null;
    if (callerSeat) {
      return { ok: false, error: `只有主持/未绑定调用者可以 rebind；当前 ${by} 已绑定为 ${callerSeat.id}。` };
    }
    const agents = (input && (input.agents || input.seats)) || null;
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
      return { ok: false, error: 'rebind 必须一次传 agents 对象，包含五席 agentId。' };
    }
    const expected = this.roster.map((seat) => seat.id);
    const keys = Object.keys(agents);
    const missing = expected.filter((seatId) => !keys.includes(seatId));
    const extra = keys.filter((seatId) => !expected.includes(seatId));
    if (missing.length || extra.length) {
      return {
        ok: false,
        error: `rebind 五席必须齐全；missing=${missing.join(',') || '—'} extra=${extra.join(',') || '—'}`,
      };
    }
    const values = {};
    for (const seatId of expected) {
      const value = String(agents[seatId] || '').trim();
      if (!value) return { ok: false, error: `rebind 的 ${seatId} agentId 不能为空。` };
      if (this.retiredAgents.has(value)) {
        return { ok: false, error: `rebind 的 ${seatId} 使用了 retired agentId：${value}` };
      }
      values[seatId] = value;
    }
    if (new Set(Object.values(values)).size !== expected.length) {
      return { ok: false, error: 'rebind 五个 agentId 必须唯一。' };
    }
    // 校验完成后才改内存，避免部分重绑
    const oldIds = this.roster.map((seat) => seat.agentId).filter(Boolean);
    const newIds = new Set(Object.values(values));
    const bindings = new Map();
    for (const seatId of expected) {
      bindings.set(seatId, { agentId: values[seatId], session: by || 'host', at: Date.now() });
    }
    for (const id of oldIds) {
      if (!newIds.has(id)) this.retiredAgents.add(id);
    }
    for (const id of newIds) {
      this.retiredAgents.delete(id);
      this.agentRoots.set(id, this.root);
    }
    for (const id of oldIds) {
      if (!newIds.has(id)) this.agentRoots.delete(id);
    }
    for (const seat of this.roster) seat.agentId = values[seat.id];
    const oldBindings = this.bindingsForRoot();
    for (const [agent, dispose] of this.agentPolicies.entries()) {
      if (agent && (oldIds.includes(agent.id) || !newIds.has(agent.id))) {
        try { dispose(); } catch { /* 已释放 */ }
        this.agentPolicies.delete(agent);
      }
    }
    oldBindings.clear();
    for (const [seatId, binding] of bindings.entries()) oldBindings.set(seatId, binding);
    this.bindingSessions.set(this.root, by || 'host');
    this.activeSessionKey = by;
    this.syncRootState();
    const p = paths(this.root);
    await writeJson(p.roster, this.roster);
    const state = await this.state();
    state.seats = state.seats || {};
    for (const seatId of expected) {
      state.seats[seatId] = {
        ...(state.seats[seatId] || {}),
        agentId: values[seatId],
        at: Date.now(),
      };
    }
    state.updatedAt = Date.now();
    await writeJson(p.state, state);
    await this.persistBindings();
    // M7.13：无条件重刷全部 live agent 的 policy；回读每席安装结果。
    this.refreshAgentPolicies();
    const policy = Object.fromEntries(
      Object.entries(values).map(([seatId, agentId]) => {
        const report = this.policyReport.get(agentId) || null;
        return [seatId, { agentId, installed: Boolean(report && report.installedAt && !report.error), error: (report && report.error) || '' }];
      }),
    );
    await this.refreshBrief();
    return {
      ok: true,
      action: 'rebind',
      session: by || 'host',
      agents: values,
      retired: [...this.retiredAgents],
      bindingWarning: this.bindingWarning(),
      policy,
    };
  }

  /**
   * M7.6：seat 身份自注册。agentId 只取调用者 exec.agent.id，不接受自报。
   * 允许条件：当前 rebind-required，或该 seat 未绑定；seat 绑给存活 agent 时拒绝抢占。
   */
  async claimSeat(seatId, input, exec) {
    const by = exec && exec.agent ? String(exec.agent.id || exec.agent.sessionId || '') : '';
    if (!by) {
      return { ok: false, error: 'claim 必须由 agent 会话调用：缺少 exec.agent.id，不能自报 agentId。' };
    }
    if (this.retiredAgents.has(by)) {
      return { ok: false, error: `claim 被拒：${by} 是已 retired 的旧会话 id；请用当前会话 claim。` };
    }
    const seat = this.roster.find((item) => item.id === seatId);
    if (!seat) {
      return { ok: false, error: `未知席位：${seatId}。可用：${this.roster.map((item) => item.id).join(' / ')}` };
    }
    const callerSeat = this.seatForAgent(by);
    if (callerSeat) {
      if (callerSeat.id === seatId) {
        return { ok: false, error: `seat ${seatId} 已绑定给当前会话 ${by}，重复 claim 被拒。` };
      }
      return { ok: false, error: `agent ${by} 已占用席位 ${callerSeat.id}，不能同时 claim ${seatId}。` };
    }
    const bindings = this.bindingsForRoot();
    for (const [otherSeatId, binding] of bindings.entries()) {
      if (otherSeatId !== seatId && binding && binding.agentId === by) {
        return { ok: false, error: `agent ${by} 已占用席位 ${otherSeatId}，不能同时 claim ${seatId}。` };
      }
    }
    const existing = bindings.get(seatId);
    if (existing && existing.agentId === by) {
      return { ok: false, error: `seat ${seatId} 已绑定给当前会话 ${by}，重复 claim 被拒。` };
    }
    if (existing && existing.agentId !== by) {
      const live = this.findLiveAgent(existing.agentId);
      // M7.10：只有“当前 session/epoch 有效”的 binding 才能以“存活 agent”为由拒绝抢占。
      // 旧 epoch claim / retired id 即使宿主进程里还活着，也已经失效，新会话可按任意顺序接管。
      if (live && this.bindingIsCurrent(existing) && !this.retiredAgents.has(existing.agentId)) {
        return { ok: false, error: `seat ${seatId} 已绑定给存活 agent ${existing.agentId}，不能抢占。` };
      }
    }
    const rebind = this.rebindRequired();
    if (!rebind && !this.unboundSeatIds().includes(seatId)) {
      return {
        ok: false,
        error: `seat ${seatId} 当前绑定有效（本会话 claim 或当前 host bind），claim 被拒；如需换人请由主持 rebind。`,
      };
    }

    const oldIds = new Set();
    if (existing && existing.agentId && existing.agentId !== by) oldIds.add(existing.agentId);
    if (seat.agentId && seat.agentId !== by) oldIds.add(seat.agentId);
    for (const oldId of oldIds) {
      if (this.roster.some((item) => item.id !== seatId && item.agentId === oldId)) continue;
      this.retiredAgents.add(oldId);
      this.agentRoots.delete(oldId);
      for (const [agent, dispose] of this.agentPolicies.entries()) {
        if (agent && agent.id === oldId) {
          try { dispose(); } catch { /* 已释放 */ }
          this.agentPolicies.delete(agent);
        }
      }
    }

    const now = Date.now();
    if (rebind || !this.bindingSessions.get(this.root)) {
      // rebind-required 时旧 session 的持久化绑定整体失效：root 的 bindingSession 切到本进程 epoch；
      // 首次 claim（此前没有 host session）也建立本进程 epoch，避免 bindings.json 写 null session。
      this.bindingSessions.set(this.root, this.bindingEpoch);
    }
    bindings.set(seatId, { agentId: by, session: this.bindingEpoch, claim: true, at: now });
    this.retiredAgents.delete(by);
    seat.agentId = by;
    this.agentRoots.set(by, this.root);
    this.activeSessionKey = by;
    this.syncRootState();

    const p = paths(this.root);
    await writeJson(p.roster, this.roster);
    const state = await this.state();
    state.seats = state.seats || {};
    state.seats[seatId] = {
      ...(state.seats[seatId] || {}),
      agentId: by,
      at: now,
    };
    state.updatedAt = now;
    await writeJson(p.state, state);
    await this.persistBindings();

    const liveAgent = this.findLiveAgent(by);
    if (liveAgent) {
      // 同一个 agent 重新 claim 时清掉旧 policy，确保 schema/ACL 立即按新席位安装。
      for (const [agent, dispose] of this.agentPolicies.entries()) {
        if (agent && agent.id === by && agent !== liveAgent) {
          try { dispose(); } catch { /* 已释放 */ }
          this.agentPolicies.delete(agent);
        }
      }
      this.installAgentPolicy(liveAgent, true);
    }
    // M7.9：claim 后再强制刷新一轮所有 live agent 的 schema filter，防止 tools/change 的竞态
    // 让 coder 在短窗口里重新看到 verdict/stage。
    try { this.refreshAgentPolicies(); } catch { /* 不阻断 claim */ }
    const report = this.policyReport.get(by) || null;
    await this.refreshBrief();
    return {
      ok: true,
      action: 'claim',
      seat: seatId,
      agentId: by,
      claim: true,
      oldAgentIds: [...oldIds].filter((id) => this.retiredAgents.has(id)),
      sessionEpoch: this.bindingEpoch,
      claimedSeats: this.claimedSeatIds(),
      unclaimedSeats: this.unclaimedSeatIds(),
      allSeatsClaimed: this.allSeatsClaimed(),
      rebindRequired: this.rebindRequired(),
      bindingWarning: this.bindingWarning(),
      policyInstalled: Boolean(report && report.installedAt && !report.error),
      policyError: (report && report.error) || '',
    };
  }

  async bindSeat(seatId, input, exec) {
    const by = exec && exec.agent ? String(exec.agent.id || exec.agent.sessionId || '') : '';
    const callerSeat = by ? this.seatForAgent(by) : null;
    if (callerSeat) {
      return { ok: false, error: `只有主持/未绑定调用者可以 bind；当前 ${by} 已绑定为 ${callerSeat.id}。` };
    }
    const agentId = String((input && input.agentId) || '').trim();
    if (!agentId) return { ok: false, error: 'bind 必须提供 agentId。' };
    const seat = this.roster.find((item) => item.id === seatId);
    if (!seat) return { ok: false, error: `未知席位：${seatId}` };
    const oldAgentId = seat.agentId || null;
    if (oldAgentId && oldAgentId !== agentId) {
      this.retiredAgents.add(oldAgentId);
      this.agentRoots.delete(oldAgentId);
      for (const [agent, dispose] of this.agentPolicies.entries()) {
        if (agent && agent.id === oldAgentId) {
          try { dispose(); } catch { /* 已释放 */ }
          this.agentPolicies.delete(agent);
        }
      }
    }
    // 同一 agentId 不能同时占两个席位；只改当前 seat 的绑定
    const bindings = this.bindingsForRoot();
    for (const item of this.roster) {
      if (item.id !== seatId && item.agentId === agentId) {
        item.agentId = null;
        bindings.delete(item.id);
      }
    }
    bindings.set(seatId, { agentId, session: by || 'host', at: Date.now() });
    this.retiredAgents.delete(agentId);
    seat.agentId = agentId;
    this.agentRoots.set(agentId, this.root);
    this.bindingSessions.set(this.root, by || 'host');
    this.activeSessionKey = by;
    this.syncRootState();
    const p = paths(this.root);
    await writeJson(p.roster, this.roster);
    const state = await this.state();
    state.seats = state.seats || {};
    state.seats[seatId] = {
      ...(state.seats[seatId] || {}),
      agentId,
      at: Date.now(),
    };
    state.updatedAt = Date.now();
    await writeJson(p.state, state);
    await this.persistBindings();
    // M7.13：无条件重刷全部 live agent 的 policy，并从 policyReport 回读本次安装结果。
    this.refreshAgentPolicies();
    const report = this.policyReport.get(agentId) || null;
    await this.refreshBrief();
    return {
      ok: true,
      action: 'bind',
      seat: seatId,
      agentId,
      oldAgentId,
      session: by || 'host',
      bindingWarning: this.bindingWarning(),
      policyInstalled: Boolean(report && report.installedAt && !report.error),
      policyError: (report && report.error) || '',
    };
  }

  findLiveAgent(agentId) {
    // M7.13：优先用 agent/created 记录的真实 handle（带 ctx/tools）。
    const known = this.agentHandles.get(agentId);
    if (known) return known;
    if (!this.ctx || !this.ctx.agents) return null;
    try {
      if (typeof this.ctx.agents.get === 'function') {
        const agent = this.ctx.agents.get(agentId);
        if (agent) {
          const id = String(agent.id || agent.agentId || (agent.session && agent.session.id) || agentId);
          this.agentHandles.set(id, agent);
          return agent;
        }
      }
      if (typeof this.ctx.agents.list === 'function') {
        for (const agent of this.ctx.agents.list()) {
          if (!agent) continue;
          const id = String(agent.id || agent.agentId || (agent.session && agent.session.id) || '');
          if (id) this.agentHandles.set(id, agent);
          if (id === agentId) return agent;
        }
      }
    } catch { /* optional service */ }
    return null;
  }

  async setSeat(input, exec) {
    await this.ensureReady();
    const action = String((input && input.action) || 'update');
    // M7.9：先判 seat 是否存在，再做 seat/action 权限判断；已绑定席位 claim 未知 seat 应报“未知席位”。
    const seatId = String((input && input.seat) || '').trim();
    if (action !== 'rebind' && !this.roster.some((seat) => seat.id === seatId)) {
      return { ok: false, error: `未知席位：${seatId}。可用：${this.roster.map((seat) => seat.id).join(' / ')}` };
    }
    const denied = this.forbiddenForSeat('foreman_seat', input, exec);
    if (denied) return { ok: false, error: denied };
    if (action === 'rebind') return this.rebindSeats(input, exec);
    if (action === 'claim') {
      return this.claimSeat(seatId, input, exec);
    }
    if (action === 'bind') {
      return this.bindSeat(seatId, input, exec);
    }
    const status = String((input && input.status) || '').trim();
    if (!SEAT_STATUS.includes(status)) return { ok: false, error: `status 只能是 ${SEAT_STATUS.join(' / ')}。` };
    const p = paths(this.root);
    const state = await this.state();
    state.seats = state.seats || {};
    const agentId = seatAgentId(this.roster, seatId);
    state.seats[seatId] = {
      status,
      note: String((input && input.note) || ''),
      at: Date.now(),
      agentId,
    };
    state.updatedAt = Date.now();
    await writeJson(p.state, state);
    await this.refreshBrief();
    return { ok: true, seat: seatId, name: seatName(this.roster, seatId), agentId, status };
  }

  async setStage(input, exec) {
    await this.ensureReady();
    const denied = this.forbiddenForSeat('foreman_stage', input, exec);
    if (denied) return { ok: false, error: denied };
    const stage = String((input && input.stage) || '').trim();
    if (!STAGES.includes(stage)) return { ok: false, error: `stage 只能是 ${STAGES.join(' / ')}。` };
    const p = paths(this.root);
    const state = await this.state();
    state.stage = stage;
    state.updatedAt = Date.now();
    await writeJson(p.state, state);
    await this.refreshBrief();
    return { ok: true, stage };
  }

  async state() {
    return (await readJson(paths(this.root).state, null)) || defaultState(this.goal);
  }

  /* ---------- 摘要（给人看的一小段） ---------- */

  async statusText() {
    if (!this.root) return '监工台未配置项目目录：请在 cordis.patch.yml 的 foreman 行设置 config.root（绝对路径）。';
    const snap = await this.snapshot();
    if (!snap.ok) return `监工台读取失败：${snap.error}`;
    const lines = [];
    lines.push(`监工台 · ${snap.goal || '未命名项目'}`);
    lines.push(`active root：${snap.root}`);
    // M7.10：绑定行始终输出（已绑定 / rebind-required / 缺失），不再只在有 warning 时出现。
    const bindingLine = snap.bindingWarning
      || (snap.allSeatsClaimed ? '已绑定五席（claim）' : '已绑定五席（bind/rebind）');
    lines.push(`绑定：${bindingLine}`);
    lines.push(`阶段：${snap.stageLabel} ｜ 当前卡：${snap.card ? snap.card.id + (snap.card.frozen ? '（冻结）' : '') : '无'}`);
    if (snap.card) {
      lines.push(`范围：${(snap.card.scope.do || []).join(' / ') || '—'} ｜ 不做：${(snap.card.scope.not || []).join(' / ') || '—'}`);
      lines.push(`验收：${(snap.card.acceptance || []).map((item, index) => `${index + 1}) ${item}`).join('；') || '—'}`);
      const gates = (snap.card.gates || []).map((gate) => {
        const hit = snap.evidence.find((entry) => (
          entry.cardId === snap.card.id && entry.gate === gate && entry.source === 'gate'
        ));
        const registryName = (snap.gateRegistry && snap.gateRegistry[gate] && snap.gateRegistry[gate].registry)
          || (snap.invalidGates && snap.invalidGates[gate] ? 'invalid' : '');
        if (!hit) return `${gate}:未跑${registryName ? `（registry ${registryName}）` : ''}`;
        if (hit.tampered) return `${gate}:tampered`;
        const whereRoot = hit.root || snap.root || '?';
        const whereCwd = hit.cwd || '?';
        const outside = hit.outsideRoot ? '，root 外' : '';
        const registry = hit.registry || registryName || '?';
        return `${gate}:exit ${hit.exitCode}（root ${whereRoot}，cwd ${whereCwd}${outside}，registry ${registry}）`;
      });
      lines.push(`门禁：${gates.join(' ｜ ') || '—'}`);
      const registryEntries = Object.values(snap.gateRegistry || {});
      const projectCount = registryEntries.filter((item) => item.registry === 'project').length;
      const configCount = registryEntries.filter((item) => item.registry === 'config').length;
      if (registryEntries.length || snap.gateRegistryError) {
        lines.push(`门禁注册：project ${projectCount} / config ${configCount}${snap.gateRegistryError ? ` ｜ ${snap.gateRegistryError}` : ''}`);
      }
      const manifest = snap.card.freezeManifest;
      if (manifest) {
        const fileCount = Array.isArray(manifest.entries) ? manifest.entries.length : 0;
        const at = Number(manifest.at);
        const frozenAt = Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : '未知时间';
        lines.push(`基线锚点：${fileCount} 文件（冻结于 ${frozenAt}）`);
      }
      const cardChallenges = (snap.challenges || []).filter((entry) => entry.cardId === snap.card.id);
      const openChallenges = cardChallenges.filter((entry) => entry.status === 'open');
      lines.push(openChallenges.length
        ? `挑战：open ${openChallenges.length}（${openChallenges.map((item) => `${item.id} by ${item.openedBy || 'unknown'}`).join(' / ')}）`
        : `挑战：无 open${cardChallenges.length ? `（最近 ${cardChallenges[cardChallenges.length - 1].status}）` : ''}`);
      const openArchives = (snap.archive || []).filter((entry) => entry.cardId === snap.card.id && entry.status === 'open');
      lines.push(`归档：open ${openArchives.length}${openArchives.length ? `（${openArchives.map((item) => item.id + ':' + item.fingerprint).join(' / ')}）` : ''}`);
    }
    const reputationLine = Object.entries(snap.reputation || {})
      .map(([id, value]) => `${id}:${value.score}/${value.trust}`)
      .join(' · ');
    if (reputationLine) lines.push(`信誉：${reputationLine}${snap.breakers && snap.breakers.length ? ` ｜ 熔断：${snap.breakers.map((item) => item.seat).join(',')}` : ''}`);
    lines.push(`公共经验：${snap.sharedLessonCount || 0} 条`);
    lines.push(`证据：${snap.evidenceCount} 条（gate ${snap.gateEvidenceCount} / reported ${snap.reportedEvidenceCount}） ｜ P0：${snap.findings.p0.length} ｜ P1：${snap.findings.p1.length}`);
    for (const item of snap.findings.p0) lines.push(`  P0 ${item.text}`);
    for (const item of snap.findings.p1) lines.push(`  P1 ${item.text}`);
    if (snap.lastVerdict) lines.push(`最近裁决：${snap.lastVerdict.verdict} · ${snap.lastVerdict.summary || ''}`);
    lines.push(`五席：${snap.roster.map((seat) => `${seat.id}:${seat.status}${seat.agentId ? '@' + seat.agentId : ''}`).join(' · ')}`);
    const policyLines = (snap.policyReport || []).map((report) => {
      const shortId = report.agentId ? report.agentId.slice(0, 8) : '?';
      const stateText = report.installedAt ? 'installed' : `not-installed${report.error ? `:${report.error}` : ''}`;
      return `${report.seat || '?'}(${shortId}):${report.mode || 'none'} ${stateText}`;
    });
    if (policyLines.length) lines.push(`policy：${policyLines.join(' ｜ ')}`);
    lines.push(`真相目录：${snap.root}\\.foreman`);
    return lines.join('\n');
  }
}

/**
 * M7.16：allowedFiles 只接受相对 root 的精确路径或 `dir/**`。
 * 返回 { ok, files }；files 为 undefined 表示调用方没传、保持旧卡不启用基线放行。
 */
function normalizeAllowedFiles(value) {
  if (value === undefined) return { ok: true, files: undefined };
  if (!Array.isArray(value)) return { ok: false, error: 'allowedFiles 必须是字符串数组。' };
  const files = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: 'allowedFiles 的每一项都必须是非空字符串。' };
    }
    let path = raw.trim().replace(/\\/g, '/');
    if (path.startsWith('./')) path = path.slice(2);
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
      return { ok: false, error: `allowedFiles 必须是相对 root 的路径：${raw}` };
    }
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return { ok: false, error: `allowedFiles 不能包含空段、. 或 ..：${raw}` };
    }
    if (path.includes('*')) {
      if (!path.endsWith('/**')) {
        return { ok: false, error: `allowedFiles 只支持精确路径或 dir/**：${raw}` };
      }
      const dir = path.slice(0, -3);
      if (!dir || dir.includes('*')) {
        return { ok: false, error: `allowedFiles 只支持精确路径或 dir/**：${raw}` };
      }
    }
    if (!files.includes(path)) files.push(path);
  }
  return { ok: true, files };
}

function isAllowedManifestPath(path, allowedFiles) {
  const value = String(path || '').replace(/\\/g, '/');
  return (allowedFiles || []).some((pattern) => {
    if (pattern.endsWith('/**')) {
      const dir = pattern.slice(0, -3).replace(/\/+$/, '');
      return value === dir || value.startsWith(`${dir}/`);
    }
    return value === pattern;
  });
}

function manifestChangedPaths(beforeEntries, afterEntries) {
  const before = new Map();
  for (const entry of beforeEntries || []) {
    if (entry && entry.path) before.set(String(entry.path).replace(/\\/g, '/'), String(entry.sha256 || ''));
  }
  const after = new Map();
  for (const entry of afterEntries || []) {
    if (entry && entry.path) after.set(String(entry.path).replace(/\\/g, '/'), String(entry.sha256 || ''));
  }
  const changed = new Set();
  for (const [path, sha256] of after.entries()) {
    if (!before.has(path) || before.get(path) !== sha256) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

function truncate(text, max) {
  if (typeof text !== 'string' || text === '') return '';
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，${text.length} 字符）`;
}
