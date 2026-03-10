# ClawAid v3 修复方案（日志采集 + 转化漏斗 + 产品修复）

## 一、为什么 200 用户 0 付费？

### 数据事实
- 200 用户，0 付费
- fix rate 39%，含 healthy 的解决率 88%
- 73% 用户来自中国（只有信用卡能付，微信/支付宝待审批）
- 免费额度：海外 1 次，中国 3 次
- paywall 数据之前没记录（刚修好写 Supabase）

### 三层根因

| 层级 | 问题 | 证据 |
|------|------|------|
| **诊断能力不足** | 日志截断丢根因，39% fix rate 太低 | jjj 亲测 4 个串联问题全没查到；`extractLogEssentials` 只保留 error 正则匹配 + 最后 20 行 |
| **支付链路断裂** | 73% 中国用户没法付 | Stripe 只有信用卡，微信/支付宝"待审批" |
| **价值感知断裂** | 用户从 GitHub issue 来，期望"免费帮助"，paywall 出现太突兀 | paywall 页面只说"额度用完"，没展示已发现的问题价值 |

---

## 二、日志采集 v3（提升诊断能力 = 提升 fix rate）

### 当前问题

```
observe.ts 读日志：200 行原始日志
    ↓
extractLogEssentials 过滤：error 正则 + 最后 20 行
    ↓
发给 Worker → AI
```

**丢失的信息：**
- `warn` 级别信号（`pairing required`、`token_mismatch`、`orphaned user message`）被正则过滤掉
- 启动时的一次性错误被后续噪音挤出 200 行
- 串联故障只能看到最新的那个

### v3 方案

```
observe.ts 读日志：全部日志
    ↓
新 extractLogEssentials：最后 50 行不过滤 + 之前的 warn/error 去重
    ↓
发给 Worker → AI
```

#### 具体改动

**文件：`src/observe.ts`**

1. `findRecentLog()` — 读取上限从 200 行改为 2000 行（或全部，取较小值）

```typescript
// 之前
const last200 = lines.slice(-200).join('\n');

// 之后
const last2000 = lines.slice(-2000).join('\n');
```

2. `extractLogEssentials()` — 重写过滤逻辑

```typescript
function extractLogEssentials(logs: string): string {
  if (!logs) return '(no logs)';
  const lines = logs.split('\n');

  // Part 1: 最后 50 行，不过滤（保留完整上下文）
  const tail = lines.slice(-50);

  // Part 2: 之前的日志，提取 warn/error 并去重
  const olderLines = lines.slice(0, -50);
  const signalPattern = /error|warn|fail|400|401|403|404|timeout|refused|crash|panic|EADDRINUSE|uncaught|unhandled|FATAL|died|exit code|mismatch|pairing|orphaned|blocked|ENOENT|EACCES|EPERM|deprecat/i;
  
  const seen = new Set<string>();
  const uniqueSignals: string[] = [];
  
  for (const line of olderLines) {
    if (!signalPattern.test(line)) continue;
    // 去重：去掉时间戳后比较
    const normalized = line.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\s*/, '').trim();
    if (normalized.length < 5) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueSignals.push(line);
  }

  const parts: string[] = [];
  
  if (uniqueSignals.length > 0) {
    // 最多保留 30 条去重后的信号
    const topSignals = uniqueSignals.slice(-30);
    parts.push(`### Unique warn/error signals from older logs (${topSignals.length} unique of ${uniqueSignals.length} total)`);
    parts.push(topSignals.join('\n'));
  }
  
  parts.push(`### Last 50 lines (unfiltered)`);
  parts.push(tail.join('\n'));

  const result = parts.join('\n\n');
  // 硬上限 20KB（50行 ≈ 5KB + 30条去重 ≈ 3KB，正常不会触发）
  return result.length > 20000 ? result.slice(0, 20000) + '\n...[truncated]' : result;
}
```

**预期效果：**
- 正常情况：50 行（~5KB）+ 10-20 条去重信号（~2KB）= ~7KB
- 最坏情况：50 行 + 30 条去重 = ~8KB，硬上限 20KB
- 之前的方案：20 行 + 30 条 error = ~5KB 但丢失 warn 级信号
- **关键改善：`warn` 级别的 `pairing required`、`token_mismatch` 不再被丢弃**

#### 额外数据源（新增采集）

**文件：`src/observe.ts` — `ObservationResult` 接口 + `observe()` 函数**

新增 3 个字段：

```typescript
// ObservationResult 新增
devicesList: string;        // `openclaw devices list` 输出（设备配对状态）
sessionHealth: string;      // `openclaw session status` 输出（会话完整性）
versionGap: string;         // 当前版本 vs latest 版本差距
```

采集命令：
```typescript
const devicesList = await runCommand('openclaw devices list 2>&1');
const sessionHealth = await runCommand('openclaw session status 2>&1');

// 版本差距
const currentVersion = obs.openclawVersion;
const latestVersion = await runCommand('npm view openclaw version 2>&1');
const versionGap = `Current: ${currentVersion} | Latest: ${latestVersion}`;
```

在 `formatObservation` 里追加：
```
## Device pairing status
${obs.devicesList}

## Session health
${obs.sessionHealth}

## Version gap
${obs.versionGap}
```

---

## 三、转化漏斗修复（让能付的人付得了）

### 3.1 中国支付（最紧急 — 73% 用户被堵在这里）

**方案：虎皮椒兜底**（已有代码基础 `handleXunhupayCreate` + `handleXunhupayWebhook`）

- Stripe 微信/支付宝审核时间不可控
- 虎皮椒 1% 手续费，个人免营业执照，即时接入
- Worker 里已有虎皮椒 handler 代码，需要：
  1. 确认虎皮椒 APPID/SECRET 已配置
  2. 客户端 paywall 页面加微信/支付宝二维码支付按钮
  3. 测试端到端：扫码 → 回调 → 生成 token → redeem

**改动文件：**
- `clawaid-worker/src/index.ts` — 检查虎皮椒逻辑是否完整
- `openclaw-doctor/web/index.html` — paywall 页面加中国支付入口

### 3.2 Paywall 页面重做（从"拦截"变为"展示价值"）

**当前：** "额度用完了，$1.99 买 5 次"
**改为：** "我们发现了 X 个问题，继续修复只需 $1.99"

具体设计：
```
┌─────────────────────────────────────────┐
│  🔍 扫描完成，发现以下问题：              │
│                                          │
│  ⚠️ [规则引擎检测到的问题列表]            │
│  ⚠️ [如果有 warn 信号也列出来]            │
│                                          │
│  免费扫描已用完                           │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │  💳 $1.99 解锁 5 次修复          │    │
│  │  ← 信用卡/Apple Pay/Google Pay   │    │
│  └──────────────────────────────────┘    │
│  ┌──────────────────────────────────┐    │
│  │  📱 ¥14.9 微信/支付宝             │    │
│  │  ← 扫码支付                       │    │
│  └──────────────────────────────────┘    │
│                                          │
│  ✅ 修好了才扣次数，修不好不扣            │
└─────────────────────────────────────────┘
```

**关键改动：**

1. 客户端在遇到 paywall 前，先把规则引擎结果和已采集的 observation 缓存住
2. paywall 页面展示规则引擎发现的问题（而不是空白的"请付费"）
3. 加上"修好才扣"的承诺（已有这个逻辑，但没在 UI 上说）

**改动文件：**
- `openclaw-doctor/src/loop.ts` — paywall 事件里携带 `ruleFindings` 数据
- `openclaw-doctor/web/index.html` — paywall 页面用 findings 渲染问题列表

### 3.3 GitHub Issue 评论预期管理

**当前评论模板：** "试试 npx clawaid"（暗示免费帮助）
**改为：** "试试 npx clawaid — 前 X 次免费诊断+修复，之后 $1.99/5次"

- 提前设定付费预期
- 让用户来之前就知道这是付费服务有免费试用

**改动文件：** HEARTBEAT.md 里的 ClawAid GitHub 评论模板

---

## 四、产品能力修复（提升 fix rate 从 39% → 60%+）

### 4.1 修复后验证（最关键的缺失功能）

**当前：** 执行 fix → AI 说"修好了" → 结束
**问题：** 串联故障修了第一个，AI 不知道后面还有

**改为：** 执行 fix → 重新采集关键指标 → AI 判断是否真的修好了

```typescript
// loop.ts — fix 步骤执行后
if (step.type === 'fix' && confirmed) {
  const output = this.executeCommand(step.command);
  
  // 修复后验证：重新采集关键指标
  const verifyOutput = this.executeCommand(
    'echo "=== POST-FIX VERIFY ===" && ' +
    'openclaw gateway status 2>&1 && echo "---" && ' +
    'openclaw status 2>&1 | head -20 && echo "---" && ' +
    'tail -10 ~/.openclaw/logs/*.log 2>/dev/null || echo "no logs"'
  );
  
  // 把验证结果也加入历史，AI 下一轮能看到
  this.history.push({ 
    step, 
    output: output + '\n\n=== POST-FIX VERIFICATION ===\n' + verifyOutput, 
    timestamp: Date.now() 
  });
}
```

### 4.2 Worker prompt 强化

在 AI system prompt 里加：

```
## VERIFICATION RULE
After any fix step, the client will automatically re-check gateway status + recent logs.
You MUST analyze the post-fix verification output before declaring done.
If new issues appear after a fix, continue investigating — DO NOT declare fixed.
```

### 4.3 规则引擎扩展

**当前 10 条规则** 覆盖了 CRITICAL 场景，但缺少：

| 新增规则 | 检测方式 | 严重级别 |
|----------|----------|----------|
| `session-corruption` | 日志中 `orphaned user message` | high |
| `token-mismatch` | 日志中 `token_mismatch` | high |
| `version-outdated` | 当前版本 vs latest 差 5+ 版本 | medium |
| `websocket-flapping` | 日志中 `disconnect` 出现 >10 次/分钟 | high |
| `device-pairing-failed` | `devices list` 显示 pairing 异常 | medium |

---

## 五、执行计划

### 第 1 天（今天）

| 优先级 | 任务 | 改动文件 | 预计时间 |
|--------|------|----------|----------|
| P0 | 日志采集 v3 — 改 `extractLogEssentials` | `observe.ts` | 30 min |
| P0 | 日志采集 v3 — 读取上限 200→2000 行 | `observe.ts` | 5 min |
| P1 | 新增 3 个数据源（devices/session/version） | `observe.ts` | 30 min |
| P1 | 修复后验证逻辑 | `loop.ts` | 30 min |
| P1 | Worker prompt 加验证规则 | `clawaid-worker/src/index.ts` | 15 min |
| P2 | Paywall 页面重做（展示问题价值） | `loop.ts` + `web/index.html` | 1 hr |

### 第 2 天

| 优先级 | 任务 | 改动文件 | 预计时间 |
|--------|------|----------|----------|
| P0 | 虎皮椒支付接通（中国用户能付钱） | `worker` + `web/index.html` | 2 hr |
| P1 | 5 条新规则引擎 | `rules.ts` | 1 hr |
| P1 | GitHub 评论模板加付费预期 | `HEARTBEAT.md` | 10 min |
| P2 | npm publish + Worker deploy + 端到端测试 | - | 1 hr |

### 验证指标

| 指标 | 当前 | Day 7 目标 |
|------|------|-----------|
| Fix rate | 39% | 55%+ |
| 中国用户能付费 | ❌ | ✅ |
| 付费用户数 | 0 | 3+ |
| Paywall → 购买转化率 | 0% | 5%+ |

---

## 六、不做的事（避免过度工程）

- ❌ 不做完整的 agentic 多轮验证（只做一次 post-fix check）
- ❌ 不改免费额度（中国 3 次、海外 1 次够了，问题在于付不了钱和 fix rate 低）
- ❌ 不加新 AI 模型（Sonnet 4.6 够用，成本 $0.035/步可控）
- ❌ 不做桌面 App（这是路线 2，另外排期）

---

## 七、风险预判

| 风险 | 概率 | 缓解 |
|------|------|------|
| 虎皮椒审核/接入问题 | 中 | 已有代码框架，主要是配置和测试 |
| 日志数据量增大导致 AI 超时 | 低 | 硬上限 20KB，正常 ~7KB |
| Post-fix verify 让流程变慢 | 低 | 只加 3 个轻量命令，<5s |
| 新规则引擎误报 | 中 | 规则只是"线索"不是门卫，AI 最终判断 |
