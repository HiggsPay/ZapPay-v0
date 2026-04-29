import "dotenv/config";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

import { v4 as uuidv4 } from "uuid";

import { supabaseAdmin } from "./lib/supabase";
import {
  createDynamicPaymentMiddleware,
  createCheckoutPaymentMiddleware,
} from "./middleware/dynamicPaymentMiddleware";
import { walletRiskMiddleware } from "./middleware/walletRiskMiddleware";
import {
  recordSuccessfulPayment,
  extractPaymentLinkFromContext,
  getPaymentLinkData,
  updateTransactionBySessionId,
} from "./services/transactionService";
import { startConfirmationPoller } from "./services/confirmationPoller";

// Route modules
import healthRoutes from "./routes/health";
import profileRoutes from "./routes/profile";
import paymentConfigRoutes from "./routes/paymentConfig";
import productsRoutes from "./routes/products";
import paymentLinksRoutes from "./routes/paymentLinks";
import transactionsRoutes from "./routes/transactions";
import checkoutRoutes from "./routes/checkout";
import sessionsRoutes from "./routes/sessions";
import riskRoutes from "./routes/risk";
import balanceRoutes from "./routes/balance";
import { sessions } from "./routes/sessions";

// ── Config ────────────────────────────────────────────────────────────────────
const facilitatorUrl = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const port = parseInt(process.env.PORT || "3001");

// ── App ───────────────────────────────────────────────────────────────────────
type AppVariables = {
  merchant?: unknown;
  walletAddress?: string;
  riskAnalysis?: unknown;
  lastSessionId?: string;
};

const app = new Hono<{ Variables: AppVariables }>();

const ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:3000", "http://localhost:5174"];
const CORS_HEADERS = [
  "Content-Type", "Authorization", "X-Requested-With",
  "access-control-expose-headers",
  "x-402-payment", "x-402-session", "x-payment",
  "x-payment-link", "X-Payment-Link", "X-Checkout-Id",
  "x-402-token", "x-402-signature", "x-402-nonce",
  "x-402-timestamp", "x-402-address", "x-402-chain-id",
  "x-402-network", "x-402-amount", "x-402-currency",
  "x-402-facilitator", "x-402-version",
  "PAYMENT-SIGNATURE", "PAYMENT-REQUIRED", "PAYMENT-RESPONSE",
];

app.use("/*", cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: CORS_HEADERS,
  exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "PAYMENT-SIGNATURE", "X-PAYMENT-RESPONSE"],
}));

// Extra CORS pass on payment endpoints (x402 middleware can clobber headers)
app.use("/api/pay/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE");
  if (c.req.method === "OPTIONS") return c.text("", 200);
  await next();
  if (origin && ALLOWED_ORIGINS.includes(origin)) c.header("Access-Control-Allow-Origin", origin);
});

// Request logger
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  console.log(`${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - start}ms)`);
});

// ── x402 Resource Server ──────────────────────────────────────────────────────
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(resourceServer);
registerExactSvmScheme(resourceServer);
resourceServer.register("stellar:*", new ExactStellarScheme());

// ── Payment middleware stack ───────────────────────────────────────────────────
app.use("/api/pay/*", walletRiskMiddleware);
app.use("/api/pay/session", createDynamicPaymentMiddleware("/api/pay/session", "$1.00", resourceServer, supabaseAdmin));
app.use("/api/pay/onetime", createDynamicPaymentMiddleware("/api/pay/onetime", "$0.10", resourceServer, supabaseAdmin));
app.use("/api/checkout/pay", walletRiskMiddleware);
app.use("/api/checkout/pay", createCheckoutPaymentMiddleware(resourceServer, supabaseAdmin));

// Post-settlement interceptor — captures tx_hash from PAYMENT-RESPONSE header
async function captureSettlementData(c: any): Promise<void> {
  if (c.res.status >= 400) return;
  const raw = c.res.headers.get("PAYMENT-RESPONSE");
  if (!raw) return;
  try {
    const settle = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    if (!settle?.success || !settle?.transaction) return;
    const sessionId = c.get("lastSessionId");
    if (!sessionId) return;
    await updateTransactionBySessionId(sessionId, settle.transaction, settle.network, settle.payer);
  } catch (err: any) {
    console.error("❌ captureSettlementData:", err.message);
  }
}

app.use("/api/pay/session",  async (c, next) => { await next(); await captureSettlementData(c); });
app.use("/api/pay/onetime",  async (c, next) => { await next(); await captureSettlementData(c); });
app.use("/api/checkout/pay", async (c, next) => { await next(); await captureSettlementData(c); });

// ── Paid endpoints (session / onetime) ───────────────────────────────────────
app.post("/api/pay/session", async (c) => {
  try {
    const sessionId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    sessions.set(sessionId, { id: sessionId, createdAt: now, expiresAt, type: "24hour" });
    c.set("lastSessionId", sessionId);

    const paymentHeader = c.req.header("payment-signature") || c.req.header("x-payment");
    let walletAddress: string | undefined;
    if (paymentHeader) {
      try {
        walletAddress = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"))
          ?.payload?.authorization?.from;
      } catch {}
    }

    const linkHash = extractPaymentLinkFromContext(c);
    let payment_link_id: string | undefined;
    let owner_id: string | null = null;
    if (linkHash) {
      const linkData = await getPaymentLinkData(linkHash);
      if (linkData) { payment_link_id = linkData.id; owner_id = linkData.owner_id; }
    }
    if (!owner_id) owner_id = null; // no global fallback in SaaS mode
    if (owner_id) {
      await recordSuccessfulPayment({
        owner_id, payment_link_id,
        amount: 1.0, currency: "USD",
        crypto_amount: 1.0, crypto_currency: "USDC",
        wallet_address: walletAddress, session_id: sessionId,
      });
    }

    return c.json({
      success: true, sessionId,
      session: { id: sessionId, type: "24hour", createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(), validFor: "24 hours" },
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post("/api/pay/onetime", async (c) => {
  try {
    const sessionId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    sessions.set(sessionId, { id: sessionId, createdAt: now, expiresAt, type: "onetime", used: false });
    c.set("lastSessionId", sessionId);

    const paymentHeader = c.req.header("payment-signature") || c.req.header("x-payment");
    let walletAddress: string | undefined;
    if (paymentHeader) {
      try {
        walletAddress = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"))
          ?.payload?.authorization?.from;
      } catch {}
    }

    const linkHash = extractPaymentLinkFromContext(c);
    let payment_link_id: string | undefined;
    let owner_id: string | null = null;
    if (linkHash) {
      const linkData = await getPaymentLinkData(linkHash);
      if (linkData) { payment_link_id = linkData.id; owner_id = linkData.owner_id; }
    }
    if (!owner_id) owner_id = null; // no global fallback in SaaS mode
    if (owner_id) {
      await recordSuccessfulPayment({
        owner_id, payment_link_id,
        amount: 0.10, currency: "USD",
        crypto_amount: 0.10, crypto_currency: "USDC",
        wallet_address: walletAddress, session_id: sessionId,
      });
    }

    return c.json({
      success: true, sessionId,
      access: { id: sessionId, type: "onetime", createdAt: now.toISOString(), validFor: "5 minutes (single use)" },
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ── Mount route modules ───────────────────────────────────────────────────────
app.route("/", healthRoutes);
app.route("/", profileRoutes);
app.route("/", paymentConfigRoutes);
app.route("/", productsRoutes);
app.route("/", paymentLinksRoutes);
app.route("/", transactionsRoutes);
app.route("/", checkoutRoutes);
app.route("/", sessionsRoutes);
app.route("/", riskRoutes);
app.route("/", balanceRoutes);

// ── Start ─────────────────────────────────────────────────────────────────────
console.log(`
🚀 ZapPay Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 Port:     ${port}
🔑 Auth:     Clerk
🔗 Networks: all (per-merchant config)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

const stopPoller = startConfirmationPoller(
  parseInt(process.env.POLL_INTERVAL_MS ?? "15000")
);
process.on("SIGTERM", () => { stopPoller(); process.exit(0); });
process.on("SIGINT",  () => { stopPoller(); process.exit(0); });

serve({ fetch: app.fetch, port });
