# 计费模型 v2

## 当前 → 新模型

| | 当前 | 新 |
|--|------|-----|
| 第一次 | 免费（中国3次，海外2次） | 免费1次（全球统一） |
| 扫描 | 免费次数内包含 | 永远免费（read步骤不收钱） |
| 修复 | 修好后扣credit | **要修之前收钱** |
| 价格 | $1.99/5次 | **¥3 / $0.5 单次** 或 **waitlist 月费** |
| paywall 时机 | session 开头 | **第一个 fix 步骤前** |
| healthy | 不扣 | 不收（没fix） |

## 改动点

### 1. Worker: paywall 时机改变

**当前：** `/step` handler 在 `sessionStart` 时检查免费额度
**改为：** 所有 read 步骤免费通过，只在 AI 返回 `type=fix` 时检查

```
POST /step → 
  if AI返回 type=read → 直接返回（免费）
  if AI返回 type=fix →
    第一次（scans=0）→ 直接返回（免费体验）
    第二次起 → 检查有没有 token/credits
      有 → 返回 fix 步骤
      没有 → 返回 paywall（附带 AI 的诊断结果）
  if AI返回 type=done → 直接返回
```

关键：paywall 返回时要带上 AI 已经发现的问题（thinking + description），让用户看到"我知道你的问题是什么，付费解锁修复"。

### 2. Worker: 扣费改到 fix 返回时

当前在 `/complete`（修好后）扣费。
改为在返回 fix 步骤时就标记"本次 session 已付费"，整个 session 内所有 fix 都不再收费。

**单次付费 = 本次 session 所有修复**，不是按 fix 步骤数。

### 3. 价格

```typescript
function getPricing(request: Request) {
  const country = request.headers.get('CF-IPCountry') || 'XX';
  const isCN = ['CN', 'HK', 'TW', 'MO'].includes(country);
  // 也检查语言
  return {
    fixOnce: {
      price: isCN ? '¥3' : '$0.5',
      priceValue: isCN ? 3 : 0.5,
      currency: isCN ? 'CNY' : 'USD',
      label: isCN ? '本次彻底解决' : 'Fix this now',
    },
    subscription: {
      price: isCN ? '¥49.99/月' : '$9.99/mo',
      label: isCN ? '持续守护 · 加入等待名单' : 'Always Protected · Join Waitlist',
      waitlist: true,
    }
  };
}
```

### 4. 前端 paywall 页面

```
┌─────────────────────────────────────────┐
│  🔍 发现问题：                            │
│                                          │
│  ⚠️ [AI 的诊断结果 - description]         │
│  💡 [AI 的修复建议 - 脱敏后的 command]      │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │  🔧 本次彻底解决 — ¥3 / $0.5     │    │
│  │  所有问题一次修完，修不好退款       │    │
│  └──────────────────────────────────┘    │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │  🛡️ 持续守护 — ¥49.99/月         │    │
│  │  7×24 保障 OpenClaw 持续健康      │    │
│  │  [加入等待名单]                    │    │
│  └──────────────────────────────────┘    │
│                                          │
│  Token 兑换 ▸                            │
└─────────────────────────────────────────┘
```

### 5. Waitlist 实现

点"加入等待名单" → 收集 email/fingerprint → 存 Supabase `waitlist` 表
不需要支付功能，先验证需求。

### 6. Stripe 价格更新

当前 Stripe 产品：$1.99 / 5次
新建：$0.5 / 单次修复
虎皮椒：¥3 / 单次

## 改动文件

| 文件 | 改什么 |
|------|--------|
| `clawaid-worker/src/index.ts` | handleStep 逻辑重写 paywall 时机 + getPricing 改价 |
| `openclaw-doctor/src/loop.ts` | paywall 事件带 AI 诊断结果 |
| `openclaw-doctor/web/index.html` | paywall 页面重做 + waitlist |
| Stripe dashboard | 新建 $0.5 产品 |
| 虎皮椒 | 改价到 ¥3 |
