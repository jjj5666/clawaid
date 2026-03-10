# v3 重新思考：你的问题打到了设计根上

## 问题 1: 为什么 2000 行？

**你说得对，2000 是拍的。** 正确思路应该是：从最后一次 gateway 启动开始截取。可能 50 行也可能 5000 行，取决于运行了多久。

但这里有个更深的问题——

## 问题 2: Log 是不是最全的？

**不是。** 我只读了 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`，实际上 OpenClaw 有 5 个日志源：

```
/tmp/openclaw/openclaw-2026-03-10.log    — 1.6MB  主日志（当前在读）
~/.openclaw/logs/gateway.log             — 12MB   gateway 运行日志
~/.openclaw/logs/gateway.err.log         — 66MB！ gateway 错误日志
~/.openclaw/logs/node.log                — 30KB   Node 进程日志
~/.openclaw/logs/node.err.log            — 6KB    Node 错误日志
```

**66MB 的 gateway.err.log 里全是错误，但 ClawAid 完全没读。** 你那次 4 个串联问题的信号大概率在这个文件里。

## 问题 3: AI post-fix 的数据从哪来？

**这是最致命的问题。**

我现在的设计是：fix 后我自己跑 4 个命令（gateway status、tail log、lsof、ps），把结果硬编码拼进去。

但你修 OpenClaw 的时候是怎么做的？**你让 Claude 告诉你该跑什么命令，你跑了把结果贴回去。** AI 根据上下文动态决定需要什么信息。

我的 re-observe 是死的 4 个命令。AI 想看 `openclaw doctor --repair` 的输出？看不了。想看 `openclaw status --all`？看不了。想看 `openclaw models status`？也看不了。

**这跟你用 Claude 修问题的流程完全不一样。**

## 问题 4: Worker prompt 怎么教 AI 收敛？

**人是怎么做的：**

```
你（指 jjj）修 OpenClaw 的真实过程：

1. 把日志丢给 Claude → Claude 说 "看到 token_mismatch，试试 gateway restart"
2. 你跑了 gateway restart → 拿到新输出 → 贴回去
3. Claude 看新输出 → "mismatch 没了，但现在有 pairing required，跑 openclaw devices list 看看"
4. 你跑了 devices list → 贴回去
5. Claude → "设备需要重新配对，跑 openclaw devices approve xxx"
6. ...
```

**核心能力：AI 动态决定下一步需要什么信息 → 人执行 → 结果反馈 → AI 再决定。**

而 ClawAid 当前：
- 预采集一堆数据丢给 AI
- AI 只能用 `read`（执行命令读数据）和 `fix`（执行修复命令）
- 但 `read` 步骤的命令是 AI 决定的！

**等等——ClawAid 的 AI 其实已经能自己决定跑什么命令了。** `read` 步骤就是 AI 告诉客户端 "帮我跑这个命令"，客户端执行后把输出给 AI。

问题不在于 AI 不能获取信息，而是：

1. **初始数据不够全** — 漏了 gateway.err.log、漏了 openclaw status --all
2. **AI 不知道有哪些 CLI 可用** — prompt 里只列了 10 个命令，但 OpenClaw 有 50+ 个子命令
3. **AI 被限制了视野** — 预采集的数据截断了，AI 以为没问题

## 根本设计缺陷

**我在替 AI 做决策。** 我预设了要采集什么数据、怎么过滤、post-fix 看什么。

正确的设计应该是：

```
人的模式（有效）:
  最小初始上下文 → AI 判断需要什么 → 执行 → 反馈 → AI 再判断 → 收敛

我的设计（低效）:
  尽可能多的预采集 → AI 在固定数据里找答案 → 修 → 硬编码的 4 个验证命令
```

## 修正方向

### 初始 observe 应该做的：
1. **5 个核心命令**（覆盖最常见信号源）：
   - `openclaw status --all` — 全面系统状态
   - `openclaw gateway status --json` — gateway 详细状态
   - `openclaw doctor` — 官方健康检查
   - 读 config 文件（脱敏）
   - 读 plist 文件

2. **日志：智能截取**
   - `/tmp/openclaw/` 最新日志 — 从最后一次 gateway 启动截取
   - `~/.openclaw/logs/gateway.err.log` — 最后 100 行
   - `~/.openclaw/logs/gateway.log` — 最后 50 行
   - 不用什么 2000 行不过滤。**按信息源分别取最有价值的部分**。

3. **然后告诉 AI：**
   > "以上是初始数据。你可以用 `read` 步骤执行任何 `openclaw` CLI 命令来获取更多信息。以下是可用的 CLI 命令..."

### post-fix 不应该硬编码
取消我写的 `reObserve()` 函数。**让 AI 自己决定修完后要检查什么。** AI 可以发一个 `read` 步骤：`openclaw gateway status && tail -20 /tmp/openclaw/*.log`。

### prompt 的核心改动
不是教 AI "这是 post-fix 验证数据"，而是：

```
你可以用两种动作：
- read: 执行任何命令获取信息（包括所有 openclaw CLI 命令）
- fix: 执行修复命令

你的目标是让系统工作。你有完整的 CLI 访问权限。
像一个远程运维工程师一样工作：查看 → 判断 → 修 → 验证 → 继续。
修完之后，用 read 步骤自己验证（不是被动等验证数据）。

可用的 OpenClaw CLI 命令：
（完整列表，不是 10 个，是 50+ 个）
```

### 利用 Opus 思考能力
当前用的是 Sonnet 4.6。如果模型有 extended thinking，AI 会在决定下一步前先推理"我看到了什么信号 → 可能的根因 → 最有价值的下一步是什么"。

考虑：
- 复杂问题切 Opus（成本高但 fix rate 高）
- 或者至少用 Sonnet 的 thinking 模式

## 总结：当前 v3 的问题

| 我做的 | 应该怎么做 |
|--------|-----------|
| 预采集 2000 行日志 | 智能截取多个日志源 + 让 AI 自己要数据 |
| 只读 /tmp/openclaw 一个日志 | 读 5 个日志源（gateway.err.log 是重灾区） |
| 硬编码 4 个 post-fix 验证命令 | 让 AI 自己用 read 步骤验证 |
| Prompt 列了 10 个 CLI 命令 | 给完整 CLI 参考 |
| 替 AI 决定要什么数据 | 给 AI 工具（read/fix），让它自己探索 |

**核心：不要替 AI 做决策。给它工具和权限，教它思维方式，让它自己收敛。**

## 要不要回退 re-observe？

当前提交的 `reObserve()` 硬编码验证并不完全是坏的——它至少保证 fix 后有一些验证数据。但长期设计应该是让 AI 自主验证。

短期可以保留 reObserve 作为"兜底"，同时让 AI 知道它可以自己 read 任何东西。长期用 AI 自主 read 替代硬编码验证。
