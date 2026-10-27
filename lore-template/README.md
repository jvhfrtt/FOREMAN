# 世界观版模板 · foreman-lore-template

给「监工台 FOREMAN」插件用的世界观写作模板。装一个插件，管所有项目；本模板把世界观写作的格式约定、门禁脚本、示例世界打包成一份，复制即用。

## 依赖

- 已安装 FOREMAN 插件（`@local/foreman`，工具 `foreman_*`）。模板**不含**插件本体。
- Node.js（跑门禁脚本）。

## 安装（三步）

1. 把本目录整体复制成你的世界观项目（或复制进现有项目根）：
   ```text
   L:\DSH\我的世界\
     docs\档案\      ← 格式约定（已带）
     docs\lore\      ← 格式约定（已带）
     scripts\lore-check.mjs   ← 门禁脚本
     tests\lore-check.test.mjs
     .foreman\gates.json      ← gate-lore 注册
   ```
2. 新对话五席 claim（按 root 隔离，各自会话）：
   ```text
   foreman_project use L:\DSH\我的世界
   foreman_seat action=claim seat=coder   # reviewer/builder/nitpicker/archivist 同理
   ```
3. 初始化两个空账本，然后开第一张卡：
   - `docs\术语表.md`：`| 词条 | 类别 | 定义 |` 表头
   - `docs\伏笔账本.md`：空文件即可（未回收伏笔必须登记进这里）

## 格式约定（六条铁律）

见 `docs/档案/README.md`、`docs/lore/README.md`。速查：

1. 档案标题 `# 类别：词条名`，同类别同名词条全库唯一，且须登记术语表
2. `@引用:裸名`——不含类别前缀；目标必须是某文件首行标题；术语表登记 ≠ 可引用
3. 时间线 `纪元-年-月 事件`，全库严格单调
4. 伏笔 `[Fx]` / 回收 `[Rx]` 配对；未回收的必须登记伏笔账本；同文件内 R 后不得再引 F
5. 小神神域窄度：单一具体名词，抽象大词黑名单报错（黑名单可按题材改 `scripts/lore-check.mjs`）
6. 新专名必须进术语表

## 流水线

```text
建卡（gates=["gate-lore"]，allowedFiles=["docs/**","scripts/**","tests/**"]）
→ freeze → 执笔者写 → Builder foreman_gate gate=gate-lore
→ 设定审查 ACCEPT（自动开挑战）→ 设定挑刺 cleared → 再 ACCEPT
```

## 门禁

`node scripts/lore-check.mjs`：全库扫描，exit 0 = 一致；报错格式 `docs/档案/xx.md:行号: 原因`。

六类检查：①标题唯一 ②时间线单调 ③伏笔配对+账本+同文件顺序 ④引用存在 ⑤术语表登记 ⑥神域窄度。

## 示例世界

`docs/示例世界-神战之后.md`：一个完整示例（骨架/规则/力量体系/团本/故事弧），展示每条规则在真实写作里怎么用。

## 已知边界（诚实声明）

- 门禁判「一致性」，不判「文学性」——拦得住吃书，拦不住“写得无聊”
- 幻觉防一半：专名/引用/时间线层面有效；“某人物做过某事”这种事实性幻觉靠设定审查兜
- 复读（段落重复）当前没有规则，如需要可另加相似度检测
- gate-lore 不跑 node:test 套件；改门禁脚本后请手工 `node --test tests/lore-check.test.mjs`
