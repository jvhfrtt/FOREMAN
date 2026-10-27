# 监工台 / FOREMAN

多智能体协作治理插件（DeepSeek Harness Host plugin）。给 AI 协作加一层**契约、真门禁、证据与裁决**，让“完成”不是一句话，而是一串可复现的证据。

## 它解决什么

裸 agent 做任务的三个风险：

| 风险 | 裸 agent | FOREMAN |
|---|---|---|
| 假绿 | 自称“测试过了” | 门禁由插件**真实执行**并记录退出码与哈希，口说无凭的 reported 证据无法通过验收 |
| 越界 | 顺手改掉范围外的文件 | 卡片冻结文件基线，ACCEPT 时逐文件比对，只允许 `allowedFiles` 内的变更 |
| 无痕 | 只有对话记忆 | 证据链（evidence/challenges/decisions）落盘，事后可复现、可追责 |

## 核心概念

- **五席**：Coder（实现）/ Reviewer（只读审查、可裁决）/ Builder（跑门禁出证据）/ Nitpicker（只读挑刺、结算挑战）/ Archivist（归档与公共经验）
- **任务契约卡**：`scopeDo / scopeNot / acceptance / gates / allowedFiles`，冻结后改范围必须主持签字
- **真门禁**：卡上声明的 gate 由插件实跑（tsc/vitest/build…），记录退出码、逐文件哈希、篡改检测；失败自动生成 P0，P0 未清零不得 ACCEPT
- **冻结基线 + allowedFiles**：ACCEPT 时强制比对，测试被偷改/新增越界文件直接拒绝
- **挑战闭环**：Reviewer 首次 ACCEPT 自动开 Nitpicker 挑战，cleared 才能放行
- **信誉账本**：每席 0–100，低于 40 熔断（breaker 阻断 ACCEPT）
- **归档 / 公共经验**：项目 bug ledger + 跨项目共享经验（promote 自动脱敏）

## 快速开始

1. 把本目录装进 profile（`package.json` 依赖 `@local/foreman` 指向本目录，或在插件市场安装本地包）
2. 重启 Harness，五个席位各自会话：

```text
foreman_seat action=claim seat=coder      # reviewer / builder / nitpicker / archivist 同理
```

3. 建卡并冻结：

```text
foreman_card action=upsert id=A1
  scopeDo=["实现 x"]
  scopeNot=["改 docs"]
  acceptance=["测试全绿","只改 src/x.ts"]
  gates=["gate-tsc","gate-vitest"]
  allowedFiles=["src/x.ts","tests/x.test.ts"]

foreman_card action=freeze id=A1 signedBy=主持 signNote="基线"
```

4. 流水线：Coder 实现 → Builder `foreman_gate` 出证据 → Reviewer ACCEPT（自动开挑战）→ Nitpicker `resolve cleared` → Reviewer 再 ACCEPT。

## 工具一览（11 个）

`foreman_status` 状态 · `foreman_project` 项目 root 切换 · `foreman_card` 契约卡/冻结/删除 · `foreman_gate` 真门禁 · `foreman_evidence` 登记证据 · `foreman_verdict` 裁决 · `foreman_challenge` 挑战 · `foreman_seat` 席位/绑定 · `foreman_archive` 归档/公共经验 · `foreman_reputation` 信誉 · `foreman_stage` 阶段推进

## 面板术语速查

- 真相目录 = <项目根>\\.foreman 状态数据目录
- registry：project=本地 .foreman/gates.json（同名覆盖 config）/ config=插件配置
- 基线锚点 = freezeManifest 文件数与冻结时间，ACCEPT 前逐文件比对
- policy：席位:allow|deny installed（allow/deny=工具过滤模式，installed=已装）
- claim 返回的 claimedSeats 是当前会话全体席位汇总，不是自己一席

## 它像什么

带强制闸门的溯源码系统 + 审查。

- 食品 HACCP：关键控制点≈gate · 纠偏≈P0/RETURN · 批记录≈evidence+freezeManifest · 放行签字≈ACCEPT
- 建筑三验：施工(Coder) → 监理审查(Reviewer) → 竣工验收(Nitpicker/主持)，缺一道不放行；改图纸必须签字

溯源码只保证「出了事能查到」，它保证「不合格的活根本放不出去」。


## 常见疑问：重启就要重新绑定吗？

**换绑不用重启；重启才要求重绑。**

- 五席 claim / 主持 rebind / 席位换代（retire）都即时生效，无需重启
- 重启 Harness 后，旧会话的 agentId 全部失效，面板显示 ebind-required——这不是 bug，是会话代际保护（防止旧会话残留 agent 冒充席位）
- 此时让当前会话五席各自 oreman_seat claim 一次（或主持 oreman_seat rebind）即可，旧 id 自动进 retired
- 改插件源码（foreman.mjs 等）才需要重启加载新代码## 已知边界（诚实声明）

- 不是 OS 级沙箱：席位 ACL 是 guard + schema 双层约束，防的是协议内越权与假绿，不是防恶意 agent 突破宿主
- 门禁证明“跑过且通过”，不能证明“测试写得对”——所以还有 Reviewer/Nitpicker 两层人肉把关
- 每项目隔离：`.foreman/` 落在项目 root；公共经验存 `%DSH_HOME%\foreman\shared`
- 成本：小型任务约 9–11 倍时间/调用（对照实验实测）；游戏实战 8 张卡 ≈149 分钟、六会话 surfaceTokens ≈156 万（≈10.2 万/卡，席位侧；宿主计量口径非 API 计费）——适合长任务/高风险任务，不适合 30 秒的小修

## 目录

- `index.js` / `client.js`：宿主插件与面板
- `cordis.patch.yml`：默认配置（root、五席、gate 注册）
- `src/host/*`：状态机、门禁、挑战、归档、信誉
- `src/client/*`：面板 UI
- `test/smoke.mjs`：537+ 条自测断言

## 许可证

私有实验项目；上传仅作展示，未附许可证前默认保留所有权利。
