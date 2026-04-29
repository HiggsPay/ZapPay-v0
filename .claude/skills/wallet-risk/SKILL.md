# ZapPay — Wallet Risk & Fraud Detection

Use this skill when: modifying risk thresholds, understanding the blocked status, working with the analysis engine, or changing how risk results surface in the UI.

---

## Architecture

```
POST /api/pay/*
  → walletRiskMiddleware  (server/middleware/walletRiskMiddleware.ts)
      → checkWalletRisk() (server/services/riskService.ts)
          → GET http://localhost:3002/api/risk/wallet/:address
              ← RiskAnalysis { riskScore, riskLevel, factors, recommendations }
      if score ≥ threshold → recordBlockedPayment() → status='blocked' → 403
      if score < threshold → next() → x402 paymentMiddleware
```

## Fail-Open Behaviour

If the analysis engine is **unreachable** (`ECONNREFUSED`), `checkWalletRisk()` returns `{ allowed: true }` and the payment proceeds. This is intentional — availability over security. To flip to fail-closed, change `riskService.ts` line ~101 to return `{ allowed: false }`.

## Risk Score Thresholds

| Score | Level | Default action |
|---|---|---|
| 0–29 | `low` | Allow |
| 30–59 | `medium` | Allow |
| 60–79 | `high` | Allow (below default threshold) |
| 80–100 | `critical` | Block |
| Any (blacklisted) | `critical` | Block immediately (score = 100) |

Default block threshold: **75** (env var `RISK_THRESHOLD`).

Blacklist file: `analysis-engine/data/blacklist.json`

## Key Files

| File | Role |
|---|---|
| `server/middleware/walletRiskMiddleware.ts` | Main middleware — extracts wallet, calls risk check, records blocked tx, returns 403 |
| `server/services/riskService.ts` | HTTP client to analysis-engine; fail-open logic |
| `analysis-engine/src/services/scoringEngine.ts` | Scoring logic — ML, AML, on-chain analysis |
| `analysis-engine/src/routes/risk.ts` | `GET /api/risk/wallet/:address` |
| `analysis-engine/data/blacklist.json` | Hardcoded block list |
| `merchant-frontend/src/pages/ZapPayUI.tsx` | Shows risk details to user on 403 response |

## Environment Variables

```
RISK_THRESHOLD=75                        # Block score (0-100), default 75
ANALYSIS_ENGINE_URL=http://localhost:3002
```

## RiskAnalysis Response Shape

```typescript
{
  walletAddress: string,
  riskScore: number,          // 0–100
  riskLevel: 'low' | 'medium' | 'high' | 'critical',
  factors: {
    walletAge, transactionHistory, addressReputation,
    behaviorPatterns, amlCompliance
  },
  recommendations: string[],  // actionable strings, some prefixed "BLOCK" or "CRITICAL"
  timestamp: string,
  cacheExpiry?: string,       // 24h cache
}
```

## Blocked Transaction Record

```typescript
recordBlockedPayment({
  owner_id,           // profiles.id UUID — from getMerchant(c).profileId or getSystemOwnerId(payTo)
  payment_link_id,    // optional — only set for payment-link flows
  amount,
  currency,
  crypto_amount,
  crypto_currency: 'USDC',
  wallet_address,
  block_reason,       // from riskCheck.blockReason or "High-risk wallet detected"
  risk_score,         // riskAnalysis.riskScore
})
// Writes status = 'blocked' to transactions table
```

**Note on `owner_id` for blocked payments:** `getSystemOwnerId(payTo)` resolves the owner by matching `payTo` against `profiles.wallet_address`. It returns `null` if no match — it no longer falls back to the first profile (removed as a multi-tenant leak). If the merchant's EVM wallet address isn't set in their profile, blocked payments for that merchant won't be attributed.

## Middleware Variants

Three versions exist in `walletRiskMiddleware.ts`:

| Export | Use case |
|---|---|
| `walletRiskMiddleware` | Standard — reads wallet from x402 headers |
| `walletRiskMiddlewareEnhanced` | Also checks request body for wallet address |
| `createWalletRiskMiddleware(threshold)` | Factory for custom per-route thresholds |

## Frontend — Blocked Payment UX

`ZapPayUI.tsx` intercepts 403 responses and fetches `/api/risk/wallet/:address` to display:
- Risk score and level
- List of recommendations
- "PAYMENT BLOCKED" message with support contact

## Decline Reason Column (Transactions page)

```tsx
transaction.status === 'blocked' ? 'Blocked by risk check' :
transaction.status === 'failed'  ? 'Payment failed' : '—'
```
