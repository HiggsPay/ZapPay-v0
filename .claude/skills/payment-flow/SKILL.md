# ZapPay — Payment Flow Architecture

Use this skill when: adding new payment endpoints, debugging payment failures, understanding middleware order, or wiring up a new payment link type.

---

## Full Request Lifecycle

```
Client (merchant-frontend ZapPayUI.tsx)
  │
  │  POST /api/pay/session  or  /api/pay/onetime
  │  Headers: payment-signature (base64 SettleResponse), x-payment-link
  ▼
[1] CORS middleware          (server/index.ts — app.use("/api/pay/*"))
[2] walletRiskMiddleware     (server/middleware/walletRiskMiddleware.ts)
      ↳ score ≥ threshold → 403 + recordBlockedPayment() → STOP
[3] paymentMiddleware        (@x402/hono — createDynamicPaymentMiddleware)
      ↳ validates payment-signature with x402.org/facilitator
      ↳ no valid payment → 402 with payment requirements → STOP
      ↳ valid payment → calls next()
[4] Route handler            (server/index.ts app.post("/api/pay/session"))
      ↳ creates session, sets c.set('lastSessionId', sessionId)
      ↳ recordSuccessfulPayment() → status = 'processing'
      ↳ returns 200 JSON { sessionId, ... }
[5] paymentMiddleware (post-next) sets PAYMENT-RESPONSE header on response
[6] Post-settlement interceptor  (server/index.ts — app.use after paymentMiddleware)
      ↳ reads PAYMENT-RESPONSE header
      ↳ updateTransactionBySessionId() patches tx_hash + network onto the row
[7] confirmationPoller       (server/services/confirmationPoller.ts — background)
      ↳ every 15s: getTransactionReceipt(tx_hash) → status = 'completed' | 'failed'
```

## Middleware Registration Order (Critical)

Order in `server/index.ts` matters — Hono executes middleware in registration order:

```
app.use("/api/pay/*", corsMiddleware)
app.use("/api/pay/*", walletRiskMiddleware)         // must be before paymentMiddleware
app.use("/api/pay/session", createDynamicPaymentMiddleware(...))
app.use("/api/pay/onetime", createDynamicPaymentMiddleware(...))
app.use("/api/pay/session", postSettlementInterceptor)   // must be after paymentMiddleware
app.use("/api/pay/onetime", postSettlementInterceptor)
app.post("/api/pay/session", routeHandler)
app.post("/api/pay/onetime", routeHandler)
```

## Payment Endpoints

| Endpoint | Price | Session type | Validity |
|---|---|---|---|
| `POST /api/pay/session` | $1.00 | `24hour` | 24 hours |
| `POST /api/pay/onetime` | $0.10 | `onetime` | 5 minutes, single use |

Prices are controlled by `createDynamicPaymentMiddleware` and can be set per-merchant from the DB.

## x402 Protocol — Payment Header

The `payment-signature` request header is a base64-encoded `PaymentPayload`:

```typescript
// Decode:
const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
decoded?.payload?.authorization?.from  // payer wallet address
```

The `PAYMENT-RESPONSE` response header (set by @x402/hono after settlement) is a base64-encoded `SettleResponse`:

```typescript
// Decode:
const settle = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
settle.transaction  // on-chain tx hash
settle.network      // CAIP-2 e.g. "eip155:8453"
settle.payer        // wallet address (more reliable than decoding payment-signature)
settle.amount       // atomic units
settle.success      // boolean
```

## Dynamic Payment Middleware

`server/middleware/dynamicPaymentMiddleware.ts` — per-merchant pricing loaded from DB.

Merchant sets their wallet address in their profile (`wallet_address` in `profiles` table). The middleware looks up the merchant's config and sets `payTo` dynamically per request.

Call `invalidateCache(profileId)` after any profile wallet address update. (`profileId` = `profiles.id` UUID, not Clerk user string.)

## Sessions (In-Memory)

```typescript
interface Session {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  type: "24hour" | "onetime";
  used?: boolean;
}
const sessions = new Map<string, Session>();
```

**Warning:** sessions are lost on server restart. In production, move to Redis or DB.

Check session validity: `GET /api/session/:sessionId`

## Adding a New Payment Endpoint

1. Register the route in `createDynamicPaymentMiddleware` call (or add a new `app.use`) with `accepts` config
2. Add a post-settlement interceptor `app.use` for the new path
3. Add the route handler — call `recordSuccessfulPayment()` and `c.set('lastSessionId', sessionId)`
4. The poller will automatically pick up `processing` rows for the new endpoint

## Checkout Pay Flow (Stripe-style)

`POST /api/checkout/pay` is a separate pay endpoint for checkout sessions (not payment links). It goes through the same middleware stack:

```
[1] walletRiskMiddleware        (app.use "/api/checkout/pay")
[2] createCheckoutPaymentMiddleware  (app.use "/api/checkout/pay") — dynamic payTo from checkout.owner_id
[3] Route handler               (server/routes/checkout.ts)
      ↳ marks checkout status = 'paid'
      ↳ recordSuccessfulPayment() → status = 'processing'
      ↳ links transaction to checkout via checkout_id
[4] Post-settlement interceptor (app.use "/api/checkout/pay")
      ↳ patches tx_hash + network via updateTransactionBySessionId()
```

Consumer sends `X-Checkout-Id` header to identify which checkout to settle.

## Key Files

| File | Role |
|---|---|
| `server/index.ts` | Middleware wiring, pay endpoint handlers, poller startup |
| `server/routes/checkout.ts` | Checkout CRUD + `/api/checkout/pay` handler |
| `server/middleware/dynamicPaymentMiddleware.ts` | Per-merchant price/wallet config |
| `server/middleware/walletRiskMiddleware.ts` | Pre-payment risk gate |
| `server/services/transactionService.ts` | All DB transaction writes (imports from `server/lib/supabase`) |
| `server/services/confirmationPoller.ts` | Background on-chain confirmation |
| `server/services/riskService.ts` | Analysis-engine HTTP client |
| `merchant-frontend/src/pages/ZapPayUI.tsx` | Public payment page (payment links + checkout sessions) |
| `merchant-frontend/src/services/api.ts` | `api.purchase24HourSession()`, `api.purchaseOneTimeAccess()`, `api.payCheckout()` |

## Facilitator

Default: `https://x402.org/facilitator` (env var `FACILITATOR_URL`)

The facilitator is the trusted third party that settles on-chain and returns the `payment-signature`. The server trusts the facilitator's signature — it does **not** independently verify on-chain at payment time. The `confirmationPoller` does the independent on-chain check asynchronously.
