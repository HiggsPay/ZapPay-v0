# ZapPay — SaaS Auth, Data Isolation & API Layer

Use this skill when: adding new API endpoints, touching auth, querying the DB, working on Settings/ApiKey/Profile pages, or onboarding to the data model.

---

## Identity Model

ZapPay uses **two IDs** — never confuse them:

| ID | Column | Type | Source | Used for |
|---|---|---|---|---|
| Clerk user ID | `profiles.clerk_user_id` | `TEXT` | Clerk JWT `sub` claim | Identity lookup only |
| Internal profile ID | `profiles.id` | `UUID` | Supabase auto-generated | `owner_id` on every table |

**Rule:** every DB query for merchant data uses `owner_id = profiles.id (UUID)`. Never use the Clerk string ID (`user_xxx`) as a data key.

---

## Auth Middleware (Server)

### Clerk JWT (`clerkAuth.ts`)

```typescript
// server/middleware/clerkAuth.ts
import { verifyToken } from "@clerk/backend";  // top-level export, NOT a method on ClerkClient

export async function clerkAuthMiddleware(c: Context, next: Next) {
  const token = c.req.header("Authorization")?.slice(7);
  const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
  const clerkUserId = payload.sub;

  // Looks up profiles.clerk_user_id; auto-provisions on first login
  // Sets c.get("merchant") = { profileId: UUID, clerkUserId, plan }
}

export function getMerchant(c: Context): MerchantContext {
  return c.get("merchant");  // throws if called outside middleware
}
```

**`getMerchant(c).profileId`** is the UUID to use as `owner_id` in all queries.

Auto-provisioning: if no profile row exists for a Clerk user, the middleware creates one using `clerkClient.users.getUser()` to pull email + display name.

### API Key (`apiKeyAuth.ts`)

```typescript
// server/middleware/apiKeyAuth.ts

// Resolves X-API-Key: zp_live_... → same MerchantContext shape as Clerk middleware.
export async function apiKeyAuthMiddleware(c: Context, next: Next) {
  const key = c.req.header("X-API-Key");
  if (!key?.startsWith("zp_live_")) return c.json({ error: "Invalid or missing X-API-Key" }, 401);

  const { data: profile } = await supabaseAdmin
    .from("profiles").select("id, plan").eq("api_key", key).single();

  if (!profile) return c.json({ error: "Invalid API key" }, 401);

  c.set("merchant", { profileId: profile.id, clerkUserId: "", plan: profile.plan });
  return next();
}

// Use on routes that should accept either auth method:
export async function clerkOrApiKeyMiddleware(c: Context, next: Next) {
  if (c.req.header("X-API-Key")) return apiKeyAuthMiddleware(c, next);
  const { clerkAuthMiddleware } = await import("./clerkAuth");
  return clerkAuthMiddleware(c, next);
}
```

**Key facts:**
- API keys are stored in `profiles.api_key` with prefix `zp_live_`
- `clerkUserId` is set to `""` (empty string) for API key auth — do not rely on it downstream
- `getMerchant(c).profileId` works identically regardless of which auth method was used
- Use `clerkOrApiKeyMiddleware` on routes that should be accessible both from the dashboard (Clerk) and programmatically (API key)
- Use `apiKeyAuthMiddleware` directly on routes that are API-only (no browser dashboard use)

---

## Frontend Auth (Clerk)

```typescript
// merchant-frontend/src/contexts/AuthContext.tsx
// This file is just a re-export — no custom logic
export { useAuth, useUser, useClerk } from "@clerk/clerk-react";
```

**Do NOT import from `@/lib/supabase`** — that file was deleted. There is no frontend Supabase client. All data goes through the server API.

### Injecting the Clerk token into API calls

`DashboardLayout.tsx` wires the token getter once on mount:
```typescript
const { getToken } = useAuth();
useEffect(() => { setClerkTokenGetter(() => getToken()); }, [getToken]);
```

`api.ts` picks it up on every request:
```typescript
baseApiClient.interceptors.request.use(async (config) => {
  if (_getClerkToken) {
    const token = await _getClerkToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

### Protected routes

```tsx
// RequireAuth.tsx
const { isLoaded, isSignedIn } = useAuth();
if (!isLoaded) return <LoadingSpinner />;
if (!isSignedIn) return <Navigate to="/auth/sign-in" replace />;
```

Auth routes live at `/auth/sign-in/*` and `/auth/sign-up/*` — Clerk hosted `<SignIn>` / `<SignUp>` components. There is no custom Auth page.

---

## No RLS — App-Layer Isolation

Supabase RLS is **disabled**. The server uses the service role key (`SUPABASE_SERVICE_ROLE_KEY`) and enforces isolation by filtering every query with `.eq("owner_id", profileId)`.

```typescript
// Every authenticated route follows this pattern:
const { profileId } = getMerchant(c);
const { data } = await supabaseAdmin
  .from("transactions")
  .select("*")
  .eq("owner_id", profileId);  // ← isolation enforced here
```

---

## Server Route Modules

```
server/routes/
  health.ts          GET /api/health
  profile.ts         GET /api/profile, PUT /api/profile/wallet, /solana-wallet, /stellar-wallet
  paymentConfig.ts   GET/PUT /api/payment-config, GET /api/payment-config/supported
  products.ts        GET/POST /api/products, PUT/DELETE /api/products/:id
  paymentLinks.ts    GET /api/payment-links, POST /api/payment-link, GET /api/pay/:paymentLink (public)
  transactions.ts    GET /api/transactions (with stats)
  checkout.ts        POST /api/checkout, GET /api/checkouts, GET/POST /api/checkout/:id, etc.
  balance.ts         GET /api/balance, POST /api/balance/sync
  sessions.ts        GET /api/sessions, GET /api/session/:id
  risk.ts            GET /api/risk/wallet/:address
```

Merchant routes use `clerkAuthMiddleware` (dashboard) or `clerkOrApiKeyMiddleware` (dashboard + API key). Mount pattern in `server/index.ts`:
```typescript
app.route("/", profileRoutes);
app.route("/", transactionsRoutes);
// etc.
```

---

## Profile API Endpoint

`GET /api/profile` — returns the authenticated merchant's full profile:

```typescript
{
  success: true,
  profile: {
    id: string,               // UUID — the owner_id
    email: string | null,
    display_name: string | null,
    wallet_address: string | null,
    solana_wallet_address: string | null,
    stellar_wallet_address: string | null,
    api_key: string | null,   // zp_live_... prefix
    plan: string,             // 'free' | 'pro' etc.
  }
}
```

Frontend usage:
```typescript
const res = await api.getProfile();
const { wallet_address, api_key } = res.profile;
```

---

## Checkout Session API (Stripe-style)

```
POST /api/checkout          Create session → returns checkout_url: ${FRONTEND_URL}/c/:id
GET  /api/checkouts         List merchant's sessions (paginated, with stats)
GET  /api/checkout/:id      Single session detail (+ linked transaction if paid)
POST /api/checkout/:id/expire   Manually expire a pending session
GET  /api/checkout/:id/payment-options   Public — options for consumer payment page
POST /api/checkout/pay      Public + x402 middleware — settle a checkout
```

Consumer payment URL: `/c/:checkoutId` → `ZapPayUI.tsx`

Checkout stats shape:
```typescript
{ pending, paid, expired, cancelled, total_revenue }
```

---

## Balance API

```
GET  /api/balance           List balances for merchant (+ total_usd)
POST /api/balance/sync      Upsert a balance row { currency, chain_id, amount, usd_value? }
```

Upsert key: `UNIQUE (owner_id, currency, chain_id)` — safe to call after every payment.

---

## DB Schema — Key Tables

```sql
profiles (
  id UUID PRIMARY KEY,          -- owner_id used everywhere
  clerk_user_id TEXT UNIQUE,    -- Clerk identity link
  email TEXT,
  display_name TEXT,
  wallet_address TEXT,          -- EVM
  solana_wallet_address TEXT,
  stellar_wallet_address TEXT,
  api_key TEXT,                 -- zp_live_ + hex
  webhook_url TEXT,
  webhook_secret TEXT,          -- whsec_ + hex
  plan TEXT DEFAULT 'free'
)

transactions (owner_id → profiles.id, checkout_id → checkouts.id, session_id, tx_hash, network, ...)
checkouts    (owner_id → profiles.id, status: pending|paid|expired|cancelled, line_items JSONB, ...)
balances     (owner_id → profiles.id, currency, chain_id, amount, usd_value, UNIQUE(owner_id,currency,chain_id))
products     (owner_id → profiles.id, ...)
payment_links(owner_id → profiles.id, ...)
```

---

## Environment Variables

**Server:**
```
CLERK_SECRET_KEY=sk_...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...   # only this — no anon key
FRONTEND_URL=http://localhost:5174
PORT=3001
```

**Frontend (`merchant-frontend/.env`):**
```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_API_BASE_URL=http://localhost:3001
```

No `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` — those are gone.

---

## Common Mistakes to Avoid

| Mistake | Correct |
|---|---|
| Using `user.id` (Clerk string) as a DB filter | Use `getMerchant(c).profileId` (UUID) |
| `.eq("user_id", ...)` | `.eq("owner_id", profileId)` or `.eq("clerk_user_id", clerkUserId)` |
| Importing `supabase` from `@/lib/supabase` in frontend | Use `api.*` from `@/services/api` |
| Calling `verifyToken` as `clerkClient.verifyToken()` | Import `verifyToken` from `"@clerk/backend"` directly |
| Direct Supabase queries from frontend | All data through server API with Clerk JWT |
| Assuming RLS protects data | Always add `.eq("owner_id", profileId)` in server queries |
| Using `clerkAuthMiddleware` on routes that need API key access | Use `clerkOrApiKeyMiddleware` instead |
| Checking `getMerchant(c).clerkUserId` after API key auth | It's `""` for API key auth — use `profileId` only |
