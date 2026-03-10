# ClawAid v3 执行计划

## 要做的事（完整清单）

| # | 事项 | 目的 | 来源 |
|---|------|------|------|
| 1 | observe.ts 停止截断日志，给 AI 完整数据 | fix rate | v3 设计方案 |
| 2 | observe.ts 新增数据源（devices/status/session/version） | fix rate | v3 设计方案 |
| 3 | loop.ts 修后 re-observe 循环（修→采集→对比→继续） | fix rate | v3 设计方案（核心） |
| 4 | rules.ts 简化（15→6 条，不确定的交给 AI） | fix rate | v3 设计方案 |
| 5 | Worker prompt 重写（教 AI 读日志→推理→修→验证） | fix rate | v3 设计方案 |
| 6 | Paywall 页面重做（展示已发现问题的价值） | 转化率 | 讨论共识 |
| 7 | warning 卡片可执行（server.ts + 前端） | 体验 | v3 设计方案 |
| 8 | 用真实故障做回归测试（5 个 mock 场景） | 验证 | v3 设计方案 |

---

## 依赖关系

```
observe.ts 重写 (#1 #2)
    ↓ AI 能看到完整数据了
Worker prompt 重写 (#5)
    ↓ AI 知道怎么用这些数据了
loop.ts re-observe (#3)
    ↓ 修完能迭代了
rules.ts 简化 (#4)
    ↓ 不再误导 AI
回归测试 (#8)
    ↓ 验证以上改动是否 work
─────────────────────
Paywall 重做 (#6) — 独立，不依赖以上
Warning 可执行 (#7) — 依赖 #3 完成
```

---

## 执行顺序 + 具体改法

### Phase 1: 给 AI 看到真相（#1 #2）

**文件：`src/observe.ts`**

**改动 A：停止截断日志**

当前：
```typescript
// findRecentLog() — 只取最后 200 行
const last200 = lines.slice(-200).join('\n');

// extractLogEssentials() — 正则过滤，只留 error + 最后 20 行
const errorPattern = /error|fail|400|404|.../i;
```

改为：
```typescript
// findRecentLog() — 找到最近一次 gateway 启动，取其后全部日志
function findRecentLog(): { content: string; logPath: string } {
  // 1. 找日志文件（逻辑不变）
  // 2. 读取全部内容
  // 3. 找最后一次 "listening on ws://" 或 "Gateway started"
  //    从这行往后就是本次启动的全部日志
  // 4. 如果 >80KB，保留：最后 50 行不过滤 + 所有 warn/error 去重
  //    （不是正则过滤，是 overflow 兜底）
}
```

关键点：
- **默认给全部日志**，只在 >80KB 时才截断
- **截断策略**：最后 50 行完整 + 之前的所有 unique warn/error/fail 行
- **删掉** `extractLogEssentials` — 这个函数是问题根源
- **删掉** `extractGatewayEssentials` 和 `extractConfigEssentials` — 同理，不要替 AI 做精简

**改动 B：新增 4 个数据源**

```typescript
interface ObservationResult {
  // ... 现有字段 ...
  
  // 新增
  devicesList: string;       // openclaw devices list --json 2>&1
  statusJson: string;        // openclaw status --json 2>&1
  sessionIntegrity: string;  // 检查 session 文件有没有 orphaned message
  versionGap: string;        // "current: 1.1.9 | latest: 1.2.3 | gap: 6"
}
```

采集（在 `observe()` 函数末尾加）：
```typescript
const devicesList = await runCommand('openclaw devices list --json 2>&1');
const statusJson = await runCommand('openclaw status --json 2>&1');

// session 完整性：简单检查最近的 session 文件
const sessionDir = path.join(homeDir, '.openclaw', 'sessions');
let sessionIntegrity = 'not checked';
if (fs.existsSync(sessionDir)) {
  // 读最近的 session 文件，grep orphaned/corrupt
  sessionIntegrity = await runCommand(
    `grep -rl "orphaned\\|corrupt\\|invalid" "${sessionDir}" 2>/dev/null | head -5 || echo "clean"`
  );
}

// 版本差距
const latestVersion = await runCommand('npm view openclaw version 2>&1');
const gap = computeVersionGap(obs.openclawVersion, latestVersion);
const versionGap = `current: ${obs.openclawVersion} | latest: ${latestVersion} | gap: ${gap}`;
```

**改动 C：`formatObservation` 不精简，全量输出**

```typescript
export function formatObservation(obs: ObservationResult): string {
  // 不调 extractXxxEssentials，直接输出原始数据
  // 只做：API key 脱敏
  return `
## System info
...（不变）

## Gateway status (raw)
${obs.gatewayStatus}

## Gateway status JSON (raw)
${redactApiKeys(obs.gatewayStatusJson)}

## Config file (${obs.configPath})
${redactApiKeys(obs.configContent)}

## LaunchAgent plist
${obs.plistContent}

## Device pairing
${obs.devicesList}

## System status
${obs.statusJson}

## Session integrity
${obs.sessionIntegrity}

## Version gap
${obs.versionGap}

## Port check
${obs.portCheck}

## Processes
${obs.processCheck}

## Official doctor output
${obs.officialDoctorOutput}

## Logs (since last gateway start)
${obs.recentLogs}
`.trim();
}
```

**预期数据量：**
- 正常系统：~15-25KB（config 5KB + status 3KB + logs 5-10KB + 其他 2KB）
- 故障系统：~30-50KB（日志更多）
- 极端：80KB 截断兜底
- Sonnet 4.6 有 200K context，30KB 完全没问题

---

### Phase 2: 教 AI 用数据（#5）

**文件：`clawaid-worker/src/index.ts` — `callAI` 函数里的 system prompt**

当前 prompt 主要是"输出 JSON 格式 + 风险评估"。

重写为：

```
你是 ClawAid 诊断引擎。你会收到一台机器上 OpenClaw 的完整系统数据。

## 思维方式

1. 先读完所有数据，特别是日志。列出你看到的所有异常信号（不只是 error，warn 也算）
2. 从信号推理根因 — 多个信号可能指向同一个问题，也可能是串联故障
3. 一次只修一个问题（最可能的根因）
4. 修完后你会收到修复前后的对比数据 — 仔细对比，判断：
   - 问题真的解决了吗？
   - 修复有没有引入新问题？
   - 还有没有其他问题需要处理？
5. 直到所有检查通过，才宣布 done

## 关键模式（加速用，但不要局限于这些）

- 日志里 `pairing required` → 设备配对问题
- 日志里 `token_mismatch` → WebUI token 不一致
- 日志里 `orphaned user message` → session 损坏
- 日志里高频 `disconnect/connect` → WebSocket 不稳定
- 版本差距 ≥3 → 考虑建议升级
- plist 里有 proxy 但不在中国 → 代理残留

## 你不知道的事就说不知道
不确定就说不确定，不要猜。宁可多读一步日志，不要假装修好了。

## 输出格式
（JSON schema 不变）
```

**关键变化：**
- 从"判断问题类型→匹配修复方案"变为"**读数据→找信号→推理→修→验证**"
- 明说"修完后你会收到对比数据" — 让 AI 知道有 re-observe
- 给几个关键模式做加速，但强调"不要局限"

---

### Phase 3: 修完能迭代（#3 — 最大的改动）

**文件：`src/loop.ts` — `runLoop()` 方法**

**当前流程：**
```
observe → [规则检查] → AI step → 执行 → AI step → ... → done
                                    ↑
                              没有重新采集
```

**v3 流程：**
```
observe(full) → 规则快修（可选，0-3轮）
     ↓
AI step → 如果是 fix：
     ↓         执行命令
     ↓         sleep(3s)
     ↓         re-observe(轻量)
     ↓         把「修复前 vs 修复后」diff 加入 history
     ↓         AI 基于 diff 决定下一步
     ↓
     → 如果是 read：正常执行，输出加入 history
     ↓
     → 如果是 done：执行 final probe
                       probe 通过 → 真的结束
                       probe 不通过 → 告诉 AI "你说修好了但 probe 失败"，继续
```

**具体实现：**

```typescript
// 新增：轻量 re-observe（只采集会变的东西）
async function reObserve(): Promise<string> {
  const parts: string[] = [];
  
  // gateway 状态
  const gwStatus = await runCommand('openclaw gateway status 2>&1');
  parts.push(`## Gateway status (post-fix)\n${gwStatus}`);
  
  // 最近 30 秒的新日志
  const newLogs = await runCommand(
    'tail -30 ~/.openclaw/logs/*.log 2>/dev/null || echo "no logs"'
  );
  parts.push(`## New logs (last 30 lines)\n${newLogs}`);
  
  // 端口检查
  const port = await runCommand('lsof -i :18789 2>&1 || echo "port free"');
  parts.push(`## Port 18789\n${port}`);
  
  // 进程检查
  const procs = await runCommand('ps aux | grep -i openclaw | grep -v grep 2>&1');
  parts.push(`## Processes\n${procs}`);
  
  return parts.join('\n\n');
}

// 在 fix 步骤执行后：
if (step.type === 'fix' && confirmed) {
  const output = this.executeCommand(step.command);
  
  // 等 gateway 重启等操作生效
  await sleep(3000);
  
  // re-observe
  const postFixState = await reObserve();
  
  // 把前后对比加入 history
  this.history.push({
    step,
    output: output + '\n\n=== POST-FIX STATE ===\n' + postFixState,
    timestamp: Date.now(),
  });
}
```

**final probe（在 AI 说 done 时执行）：**

```typescript
if (step.type === 'done' && step.fixed) {
  // AI 说修好了，我们验证一下
  const probe = await runCommand(
    'openclaw gateway status 2>&1 && echo "EXIT:$?"'
  );
  const probeOk = probe.includes('running') || probe.includes('"status":"ok"');
  
  if (!probeOk && probeRetries < 2) {
    // probe 失败，告诉 AI 继续
    this.history.push({
      step: { type: 'read', description: 'Final probe FAILED', command: '' },
      output: `AI declared fixed but probe shows:\n${probe}\nPlease re-evaluate.`,
      timestamp: Date.now(),
    });
    probeRetries++;
    continue; // 回到循环，让 AI 继续
  }
  
  // probe 通过或重试耗尽，结束
  // ...existing done logic...
}
```

---

### Phase 4: 规则简化（#4）

**文件：`src/rules.ts`**

从 ~15 条砍到 6 条（只保留 100% 确定、不需要 AI 判断的）：

| 保留 | 检测方式 | 确信度 |
|------|----------|--------|
| `gateway-not-running` | 进程不存在 | 100% |
| `port-conflict` | lsof 非 openclaw 进程占 18789 | 100% |
| `config-parse-error` | JSON.parse 失败 | 100% |
| `node-too-old` | Node < 18 | 100% |
| `proxy-in-plist` | plist 有 HTTP_PROXY | 100%（但可能是故意的，标 medium） |
| `token-mismatch` | 日志里有 token_mismatch | 100% |

**删除的规则：** 所有需要"猜测"的规则 — 交给 AI 看完整数据自己判断。规则只做确定性加速，**不做门卫**。

---

### Phase 5: 转化 + 体验（#6 #7）

**Paywall 重做（#6）— 文件：`src/loop.ts` + `web/index.html`**

loop.ts 改动：paywall 事件携带已发现的问题
```typescript
// 在 paywall 返回时
this.emit({
  type: 'paywall',
  data: {
    price: err.price,
    // 新增：已发现的问题列表
    findings: this.observation?.ruleFindings || [],
    observationSummary: this.buildQuickSummary(),
  }
});
```

前端改动：paywall 页面展示 findings
```
┌────────────────────────────────────────┐
│  🔍 扫描发现以下问题：                   │
│                                         │
│  ⚠️ Gateway 未运行                      │
│  ⚠️ Config 文件解析错误                  │
│                                         │
│  继续修复 → $1.99 / 5次（修好才扣）       │
│  [信用卡/Apple Pay]  [微信/支付宝]        │
└────────────────────────────────────────┘
```

**Warning 可执行（#7）— 文件：`src/server.ts` + `web/index.html`**

结果页的 warning 卡片加 action 按钮，用户点击直接执行修复命令。

---

### Phase 6: 回归测试（#8）

用 jjj 3/10 的真实故障做 5 个 mock 场景：

| 场景 | 问题 | 通过标准 |
|------|------|----------|
| session-corruption | orphaned user message | AI 找到并修复 |
| pairing-required | 设备配对被拒 | AI 找到并建议修复 |
| token-mismatch | WebUI token 不一致 | AI 找到并修复 |
| ws-flapping | WebSocket 高频断连 | AI 识别并建议升级 |
| **combined-cascade** | 以上 4 个同时出现 | AI 逐个修复，不在第一个就宣布 done |

---

## 为什么这能到 90%+

当前 39% 的失败拆解：

```
失败原因              占比    v3 是否解决
─────────────────────────────────────────
AI 看不到问题         ~35%    ✅ 不截断日志 + 新数据源
修了第一个就宣布完成   ~20%    ✅ re-observe + final probe
规则误导 AI           ~5%     ✅ 砍到 6 条
等太久放弃            ~10%    ⚠️ 部分（re-observe 加几秒，但 fix 准确率高 = 总轮次少）
支付被堵              ~15%    ✅ 已接虎皮椒
AI 推理错误           ~10%    ⚠️ prompt 改善，但无法 100% 消除
无法远程修的问题       ~5%     ❌ 需要人工（如硬件、网络）
```

- "AI 看不到" + "修了就宣布完成" = 55% 的失败原因，v3 直接解决
- 支付 15% 已解决
- 规则误导 5% 解决
- **理论 fix rate：39% + (55%+5%) × 0.8 = ~87%，加上 prompt 改善 → 90%+**
- 剩下 ~10% 是 AI 推理错误 + 无法远程修，需要更多数据积累

---

## 改动量估算

| 文件 | 改动量 | 时间 |
|------|--------|------|
| observe.ts | 重写 ~150 行 | 1.5h |
| loop.ts | 重写核心循环 ~200 行 | 2h |
| Worker prompt | 重写 ~80 行 | 30min |
| rules.ts | 删代码为主 | 30min |
| web/index.html paywall | ~100 行 | 1h |
| server.ts warning action | ~30 行 | 30min |
| 5 个 mock 测试 | ~200 行 JSON | 1h |
| 合计 | ~760 行改动 | **~7h** |

---

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| 完整日志太大导致 AI 超时 | 低 | 80KB 截断兜底；Sonnet 4.6 200K context |
| re-observe 让每次修复多 3-5s | 确定 | 可接受：准确率高 = 总轮次少 = 总时间可能更短 |
| 删规则后某些之前能快修的问题变慢 | 中 | 保留了 6 条最确定的；其他只是从规则→AI，不是丢失 |
| combined-cascade 测试不通过 | 中 | 这是最难的场景，可能需要调 prompt |
