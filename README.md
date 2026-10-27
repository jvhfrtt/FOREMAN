# 监工台 FOREMAN · 全量包

一个 zip 搞定：**插件本体 + 世界观模板**。装一个插件，代码开发与世界观写作两种场景都能用。

## 目录

```text
foreman-plugin\    插件本体（@local/foreman，含 M7.19 受理文案）
lore-template\     世界观模板（七类检查门禁 + 格式约定 + 示例世界）
```

## 安装（两步）

### 1. 装插件

把 `foreman-plugin` 作为本地依赖装进 DSH profile：

- `package.json` 加依赖 `"@local/foreman": "link:<绝对路径>/foreman-plugin"`
- 或插件市场安装本地包指向该目录
- 重启 Harness；新对话里 `foreman_status` 能出面板即成功

### 2. 用世界观模板（可选）

把 `lore-template` 复制成你的项目（或复制进现有项目根），新对话：

```text
foreman_project use <你的项目根>
foreman_seat action=claim seat=coder   # 五席各自会话
```

模板自带：格式约定（档案/lore README）、术语表与伏笔账本空模板、`lore-check` 门禁脚本（七类检查）、`gate-lore` 注册、示例世界《神战之后》。

#### 世界观模板完整步骤

1. **复制模板**到你的项目根（如 `L:\DSH\我的世界`）。
2. **改两处机器相关配置（易漏）**：
   - `.foreman/gates.json` 里 `argv` 第一项改成你本机的 node 绝对路径
   - `foreman-plugin/cordis.patch.yml` 的 `root` 改成你的项目根（或 `<项目根>` 占位符）
3. **五席 claim**（各自会话）：`foreman_project use <项目根>` 后 `foreman_seat action=claim seat=coder`（reviewer/builder/nitpicker/archivist 同理）。
4. **开第一张卡**：
   ```text
   foreman_card action=upsert id=LORE-1
     scopeDo=["写第一个设定条目"] scopeNot=["故事正文"]
     acceptance=["条目格式正确","术语表登记","gate-lore exit 0"]
     gates=["gate-lore"]
     allowedFiles=["docs/**","scripts/**","tests/**"]
   foreman_card action=freeze id=LORE-1 signedBy=主持 signNote="基线"
   ```
5. **跑流水线**：执笔者写 → `foreman_gate gate=gate-lore` → 设定审查 ACCEPT（自动开挑战）→ 设定挑刺 resolve cleared → 再 ACCEPT。
6. 第一张卡建议写一个小神或聚落，照 `docs/示例世界-神战之后.md` 的格式抄。


## 常见疑问：重启就要重新绑定吗？

**换绑不用重启；重启才要求重绑。**

- 五席 claim / 主持 rebind / 席位换代（retire）都即时生效，无需重启
- 重启 Harness 后，旧会话的 agentId 全部失效，面板显示 ebind-required——这不是 bug，是会话代际保护（防止旧会话残留 agent 冒充席位）
- 此时让当前会话五席各自 oreman_seat claim 一次（或主持 oreman_seat rebind）即可，旧 id 自动进 retired
- 改插件源码（foreman.mjs 等）才需要重启加载新代码## 它像什么

**带强制闸门的溯源码系统 + 审查。**

| 类比 | 对应 |
|---|---|
| 食品 HACCP | 关键控制点≈gate · 纠偏≈P0/RETURN · 批记录≈evidence+freezeManifest · 放行签字≈ACCEPT |
| 建筑三验 | 施工(Coder) → 监理审查(Reviewer) → 竣工验收(Nitpicker/主持)，缺一道不放行；改图纸必须签字 |

溯源码只保证「出了事能查到」，它保证「不合格的活根本放不出去」。

## 两种场景

| 场景 | gate | 门禁判据 |
|---|---|---|
| 写代码 | tsc / vitest / build | 编译/测试/构建真跑 |
| 写世界观 | gate-lore | ①标题唯一 ②时间线单调 ③伏笔配对+账本 ④引用存在 ⑤术语表登记 ⑥神域窄度 ⑦防复读 |

## 详细文档

- 插件使用：[foreman-plugin/README.md](foreman-plugin/README.md)
- 世界观版：[lore-template/世界观版使用说明.md](lore-template/世界观版使用说明.md)
- 模板说明：[lore-template/README.md](lore-template/README.md)
