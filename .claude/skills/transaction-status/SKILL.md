# ZapPay — Transaction Status System

Use this skill when: working with transaction statuses, adding new status transitions, querying transactions, or updating the Transactions UI.

---

## Status Definitions

| Status | Written by | Meaning |
|---|---|---|
| `pending` | nobody yet | Valid enum value; reserved for future "payment link opened" event |
| `processing` | `recordSuccessfulPayment()` | x402 facilitator confirmed the payment signature |
| `completed` | `updateTransactionStatus()` (poller) | On-chain receipt confirmed — tx settled on the blockchain |
| `failed` | `recordFailedPayment()` or poller | Payment reverted on-chain, or stale after 30 min with no receipt |
| `blocked` | `recordBlockedPayment()` | Wallet rejected by risk middleware before payment was attempted |
| `cancelled` | nobody yet | Valid enum value; reserved for future "user abandoned" event |

## Status Flow

```
[user opens payment link]
        ↓
walletRiskMiddleware
  ├─ score ≥ 75 → blocked (written immediately, 403 returned)
  └─ score < 75 → continue
        ↓
x402 paymentMiddleware (facilitator validates signature)
        ↓
route handler → recordSuccessfulPayment() → processing
        ↓
post-settlement interceptor patches tx_hash + network onto the row
        ↓
confirmationPoller (every 15s)
  ├─ receipt.status = success  → completed
  ├─ receipt.status = reverted → failed
  └─ no receipt after 30min   → failed
```

## Database Constraint

```sql
status TEXT CHECK (status IN ('pending','processing','completed','failed','blocked','cancelled')) NOT NULL
```

## Key Files

| File | Role |
|---|---|
| `server/services/transactionService.ts` | All DB write helpers |
| `server/middleware/walletRiskMiddleware.ts` | Writes `blocked` |
| `server/services/confirmationPoller.ts` | Writes `completed` / `failed` via on-chain check |
| `server/index.ts` | Route handlers write `processing`; post-settlement interceptor patches `tx_hash` |
| `merchant-frontend/src/pages/Transactions.tsx` | UI — status cards, badge colors, label mapping |
| `merchant-frontend/src/components/common/StatusBadge.tsx` | Badge color map |

## transactionService.ts — Helper Reference

```typescript
recordSuccessfulPayment(params)   // → processing
recordFailedPayment(params)       // → failed
recordBlockedPayment(params)      // → blocked
updateTransactionStatus(id, 'completed' | 'failed')  // idempotent, only updates if still 'processing'
updateTransactionBySessionId(sessionId, txHash, network, walletAddress?)  // patches tx_hash onto row
getPendingTransactions(limit?)    // fetches processing rows with non-null tx_hash for the poller
```

## Frontend Status → Color Mapping

| Status | Badge color |
|---|---|
| `processing` | Blue |
| `completed` | Green |
| `pending` | Yellow |
| `failed` | Red |
| `blocked` | Orange |
| `cancelled` | Gray |

## GET /api/transactions — Stats Response Shape

```typescript
{
  stats: {
    total: number,
    processing: number,
    completed: number,
    pending: number,
    failed: number,
    blocked: number,
    cancelled: number,
    totalAmount: number,  // sum of 'processing' rows (until on-chain verification ships)
  }
}
```

## Adding a New Status

1. Add to DB CHECK constraint (migration + `supabase-migration.sql`)
2. Add to `TransactionData` interface in `transactionService.ts`
3. Add to `Transaction` interface in `merchant-frontend/src/services/api.ts`
4. Add to `TransactionStats` if it needs a count
5. Add badge color in `StatusBadge.tsx`
6. Add label/card in `Transactions.tsx`
