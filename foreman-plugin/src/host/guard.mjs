/**
 * M3.2：按 roster 真实 agentId 的 guard 级 ACL。
 * 只返回拒绝原因；undefined 放行。没有 agentId 的调用（主持/普通对话）不限制。
 * M7.7：foreman_* 不再整类放行，按 seat + action 白名单判定；schema/业务入口各自再挡一次。
 */
const REVIEW_ALLOWED = new Set(['read', 'grep', 'glob', 'read_image']);
const REVIEW_DENIED = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'pwsh',
  'bash',
  'terminal',
  'subagent',
  'subagent_fork',
  'workflow',
  'job_kill',
  'create_goal',
]);
const BUILDER_DENIED = new Set(['write', 'edit', 'str_replace_editor']);
// M7.9：claim 时先判未知席位，再判“只能 claim 自己”；与业务入口 setSeat 的顺序保持一致。
const SEAT_IDS = new Set(['coder', 'reviewer', 'builder', 'nitpicker', 'archivist']);

/** 主持（未绑定）以外，各席位可用的 foreman_* 治理动作。 */
export function foremanActionReason(seatId, name, args) {
  const seat = String(seatId || '');
  if (!seat) return undefined;
  const action = args && typeof args === 'object' && args.action !== undefined
    ? String(args.action)
    : '';
  switch (name) {
    case 'foreman_status':
    case 'foreman_project':
    case 'foreman_evidence':
    case 'foreman_gate':
      return undefined;

    case 'foreman_card':
      return `${seat} 不能调用 foreman_card：任务卡建/改/冻结/删除属于主持职责，席位只能用 foreman_status 读`;
    case 'foreman_stage':
      return `${seat} 不能调用 foreman_stage：推进阶段属于主持职责`;

    case 'foreman_verdict':
      if (seat === 'reviewer') return undefined;
      return `${seat} 不能调用 foreman_verdict：只有 Reviewer 或主持可以裁决`;

    case 'foreman_archive':
      if (action === 'search' || action === 'list') return undefined;
      if (seat === 'archivist') return undefined;
      return `${seat} 不能调用 foreman_archive ${action || '变更'}：归档变更只允许 archivist 或主持；只读可 search/list`;

    case 'foreman_reputation':
      if (action === 'status' || action === 'list') return undefined;
      return `${seat} 不能修改信誉分：只有主持可以 award/penalize；只读可 status/list`;

    case 'foreman_seat':
      if (action === 'bind' || action === 'rebind') {
        return `${seat} 不能调用 foreman_seat ${action}：bind/rebind 只有主持可以`;
      }
      if (action === 'claim') {
        const target = args && typeof args === 'object' ? String(args.seat || '') : '';
        if (!target) return 'claim 必须指定 seat';
        if (!SEAT_IDS.has(target)) {
          return `未知席位：${target}。可用：${[...SEAT_IDS].join(' / ')}`;
        }
        if (target !== seat) return `${seat} 不能 claim 席位 ${target}：claim 只允许席位自己`;
        return undefined;
      }
      return undefined;

    case 'foreman_challenge':
      if (action === 'resolve') {
        return seat === 'nitpicker'
          ? undefined
          : `${seat} 不能 resolve challenge：只有 Nitpicker 或主持可以 resolve，open/list 仍允许`;
      }
      return undefined;

    default:
      return `${seat} 不能调用未授权的治理工具 ${name}`;
  }
}

function seatForAgent(roster, agentId) {
  if (!agentId) return null;
  return (roster || []).find((seat) => seat && seat.agentId === agentId) || null;
}

export function createSeatGuard(getSeat) {
  return (exec) => {
    const name = exec && exec.name ? String(exec.name) : '';
    const agentId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : '';
    if (!agentId || !name) return undefined;
    const seat = typeof getSeat === 'function'
      ? getSeat(agentId)
      : seatForAgent(getSeat, agentId);
    if (!seat) return undefined;
    if (seat.id === 'retired') {
      return '该 agentId 属于旧会话席位，已失效；请当前会话重新 bind/claim 后再操作。';
    }

    if (name.startsWith('foreman_')) {
      return foremanActionReason(seat.id, name, exec.arguments);
    }

    if (seat.id === 'reviewer' || seat.id === 'nitpicker' || seat.id === 'archivist') {
      if (REVIEW_ALLOWED.has(name)) return undefined;
      if (REVIEW_DENIED.has(name)) {
        return `${seat.id} 是只读审查/归档席位，禁止调用 ${name}`;
      }
      return `${seat.id} 是只读审查/归档席位，只允许 read/grep/glob/read_image，禁止调用 ${name}`;
    }

    if (seat.id === 'builder') {
      if (BUILDER_DENIED.has(name)) return `builder 禁止修改源码：${name} 只允许执行/构建/读取，不允许改源码或测试`;
      return undefined;
    }

    if (seat.id === 'coder') {
      return undefined;
    }

    return undefined;
  };
}
