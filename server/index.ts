import { config } from "dotenv";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import type { Network } from "@x402/core/types";
import { createDynamicPaymentMiddleware, createCheckoutPaymentMiddleware, invalidateCache } from "./middleware/dynamicPaymentMiddleware";
import { getTokenConfig, SUPPORTED_TOKENS } from "./tokenRegistry";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { walletRiskMiddleware } from "./middleware/walletRiskMiddleware";
import { recordSuccessfulPayment, recordFailedPayment, extractPaymentAmount, getSystemOwnerId, extractPaymentLinkFromContext, getPaymentLinkData, updateTransactionBySessionId } from "./services/transactionService";
import { startConfirmationPoller } from "./services/confirmationPoller";

config();

// Configuration from environment variables
const facilitatorUrl = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const payTo = process.env.ADDRESS as `0x${string}`;
const networkEnv = process.env.NETWORK || "base-sepolia";
const port = parseInt(process.env.PORT || "3002");

// Map legacy network names to CAIP-2 identifiers required by x402 v2.
function toCaip2(n: string): Network {
  const map: Record<string, string> = {
    "base-sepolia": "eip155:84532",
    "base": "eip155:8453",
    "scroll": "eip155:534352",
    "scroll-sepolia": "eip155:534351",
    "ethereum": "eip155:1",
    "sepolia": "eip155:11155111",
    "solana-devnet": "solana:devnet",
    "solana": "solana:mainnet",
  };
  return (map[n] ?? n) as Network;
}
const network: Network = toCaip2(networkEnv);

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
  console.error("❌ Please set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in the .env file");
  process.exit(1);
}

// Initialize Supabase clients
const supabase = createClient(supabaseUrl, supabaseAnonKey);
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

if (!payTo) {
  console.error("❌ Please set your wallet ADDRESS in the .env file");
  process.exit(1);
}

type AppVariables = {
  walletAddress?: string;
  riskAnalysis?: unknown;
  lastSessionId?: string;
};

const app = new Hono<{ Variables: AppVariables }>();

// Enable CORS for frontend
app.use("/*", cors({
  origin: ["http://localhost:5173", "http://localhost:3000", "http://localhost:5174"],
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "access-control-expose-headers",
    "x-402-payment",
    "x-402-session",
    "x-payment",
    "x-payment-link",
    "X-Payment-Link",
    "x-402-token",
    "x-402-signature",
    "x-402-nonce",
    "x-402-timestamp",
    "x-402-address",
    "x-402-chain-id",
    "x-402-network",
    "x-402-amount",
    "x-402-currency",
    "x-402-facilitator",
    "x-402-version",
    "PAYMENT-SIGNATURE",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
  ],
  exposeHeaders: [
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "PAYMENT-SIGNATURE",
    "X-PAYMENT-RESPONSE",
  ],
}));

// Basic logging middleware
app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const url = c.req.url;
  
  await next();
  
  const end = Date.now();
  const duration = end - start;
  console.log(`${method} ${url} - ${c.res.status} (${duration}ms)`);
});

// Helper function to get user ID from JWT token
async function getUserIdFromToken(c: any): Promise<string | null> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.substring(7);
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return null;
    }
    return user.id;
  } catch (error) {
    console.error('Error verifying token:', error);
    return null;
  }
}

// Simple in-memory storage for sessions (use Redis/DB in production)
interface Session {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  type: "24hour" | "onetime";
  used?: boolean;
}

const sessions = new Map<string, Session>();

// Apply CORS to payment endpoints BEFORE x402 middleware
app.use("/api/pay/*", async (c, next) => {
  const origin = c.req.header('Origin');
  const allowedOrigins = ["http://localhost:5173", "http://localhost:3000", "http://localhost:5174"];
  
  // Debug: Log all request headers
  console.log('🔍 Payment endpoint request headers:', Object.fromEntries(c.req.raw.headers.entries()));
  
  // Set CORS headers
  if (origin && allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
  }
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, access-control-expose-headers, x-402-payment, x-402-session, x-payment, x-payment-link, X-Payment-Link, x-402-token, x-402-signature, x-402-nonce, x-402-timestamp, x-402-address, x-402-chain-id, x-402-network, x-402-amount, x-402-currency, x-402-facilitator, x-402-version, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE, X-PAYMENT-RESPONSE');

  if (c.req.method === 'OPTIONS') {
    console.log('✅ Handling OPTIONS preflight request');
    return c.text('', 200);
  }

  await next();

  // Ensure CORS headers are preserved after x402 middleware
  if (origin && allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
  }
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, access-control-expose-headers, x-402-payment, x-402-session, x-payment, x-payment-link, X-Payment-Link, x-402-token, x-402-signature, x-402-nonce, x-402-timestamp, x-402-address, x-402-chain-id, x-402-network, x-402-amount, x-402-currency, x-402-facilitator, x-402-version, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE, X-PAYMENT-RESPONSE');
});

// Apply wallet risk middleware BEFORE payment processing
// This blocks high-risk wallets before they can attempt to pay
app.use("/api/pay/*", walletRiskMiddleware);

// Configure x402 v2 payment middleware with two payment options.
// Build a facilitator client + resource server, register the EVM "exact" scheme
// (wildcard eip155:* so any EVM chain works), then mount the middleware.
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(resourceServer);
registerExactSvmScheme(resourceServer);
resourceServer.register("stellar:*", new ExactStellarScheme());

app.use("/api/pay/session", createDynamicPaymentMiddleware("/api/pay/session", "$1.00", resourceServer, supabaseAdmin));
app.use("/api/pay/onetime", createDynamicPaymentMiddleware("/api/pay/onetime", "$0.10", resourceServer, supabaseAdmin));
app.use("/api/checkout/pay", walletRiskMiddleware);
app.use("/api/checkout/pay", createCheckoutPaymentMiddleware(resourceServer, supabaseAdmin));

// Post-settlement interceptors: read PAYMENT-RESPONSE header after x402 middleware sets it
// (the header is only available after next() returns, not inside the route handler)
async function captureSettlementData(c: any): Promise<void> {
  if (c.res.status >= 400) return;
  const raw = c.res.headers.get('PAYMENT-RESPONSE');
  if (!raw) return;
  try {
    const settle = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    if (!settle?.success || !settle?.transaction) return;
    const sessionId = c.get('lastSessionId');
    if (!sessionId) return;
    await updateTransactionBySessionId(sessionId, settle.transaction, settle.network, settle.payer);
  } catch (err: any) {
    console.error('❌ captureSettlementData error:', err.message);
  }
}

app.use("/api/pay/session",   async (c, next) => { await next(); await captureSettlementData(c); });
app.use("/api/pay/onetime",   async (c, next) => { await next(); await captureSettlementData(c); });
app.use("/api/checkout/pay", async (c, next) => { await next(); await captureSettlementData(c); });

// Apply CORS to all other routes
app.use("/*", cors({
  origin: ["http://localhost:5173", "http://localhost:3000", "http://localhost:5174"],
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "access-control-expose-headers",
    "x-402-payment",
    "x-402-session",
    "x-payment",
    "x-payment-link",
    "X-Payment-Link",
    "x-402-token",
    "x-402-signature",
    "x-402-nonce",
    "x-402-timestamp",
    "x-402-address",
    "x-402-chain-id",
    "x-402-network",
    "x-402-amount",
    "x-402-currency",
    "x-402-facilitator",
    "x-402-version",
    "PAYMENT-SIGNATURE",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
  ],
  exposeHeaders: [
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "PAYMENT-SIGNATURE",
    "X-PAYMENT-RESPONSE",
  ],
}));

// Add a global response interceptor to ensure CORS headers are always present
app.use("/*", async (c, next) => {
  await next();

  // Ensure CORS headers are present on all responses
  const origin = c.req.header('Origin');
  const allowedOrigins = ["http://localhost:5173", "http://localhost:3000", "http://localhost:5174"];

  if (origin && allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
  }
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, access-control-expose-headers, x-402-payment, x-402-session, x-payment, x-payment-link, X-Payment-Link, x-402-token, x-402-signature, x-402-nonce, x-402-timestamp, x-402-address, x-402-chain-id, x-402-network, x-402-amount, x-402-currency, x-402-facilitator, x-402-version, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE, X-PAYMENT-RESPONSE');
});

// Token registry for frontend
app.get("/api/payment-config/supported", (c) => {
  return c.json({ supported: SUPPORTED_TOKENS });
});

// Get merchant's current payment config
app.get("/api/payment-config", async (c) => {
  const userId = await getUserIdFromToken(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  const { data, error } = await supabaseAdmin
    .from("merchant_payment_configs")
    .select("*")
    .eq("owner_id", userId);
  if (error) return c.json({ error: "DB error" }, 500);
  return c.json({ success: true, configs: data });
});

// Replace merchant's full payment config
app.put("/api/payment-config", async (c) => {
  const userId = await getUserIdFromToken(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  const body = await c.req.json() as { configs: Array<{ chain_id: string; token_symbol: string }> };
  const { configs } = body;
  if (!Array.isArray(configs)) return c.json({ error: "configs must be an array" }, 400);
  for (const entry of configs) {
    if (!getTokenConfig(entry.chain_id, entry.token_symbol))
      return c.json({ error: `Unsupported: ${entry.chain_id}/${entry.token_symbol}` }, 400);
  }
  await supabaseAdmin.from("merchant_payment_configs").delete().eq("owner_id", userId);
  if (configs.length > 0) {
    const rows = configs.map(entry => {
      const token = getTokenConfig(entry.chain_id, entry.token_symbol)!;
      return { owner_id: userId, chain_id: entry.chain_id, token_symbol: entry.token_symbol, asset: token.asset, enabled: true };
    });
    const { error } = await supabaseAdmin.from("merchant_payment_configs").insert(rows);
    if (error) return c.json({ error: "DB error" }, 500);
  }
  invalidateCache(userId);
  return c.json({ success: true });
});

// Save EVM wallet address
app.put("/api/profile/wallet", async (c) => {
  const userId = await getUserIdFromToken(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  const { wallet_address } = await c.req.json();
  if (!wallet_address?.match(/^0x[0-9a-fA-F]{40}$/))
    return c.json({ error: "Invalid Ethereum address" }, 400);
  const { error } = await supabaseAdmin.from("profiles").update({ wallet_address }).eq("user_id", userId);
  if (error) return c.json({ error: "DB error" }, 500);
  invalidateCache(userId);
  return c.json({ success: true });
});

// Save Solana wallet address
app.put("/api/profile/solana-wallet", async (c) => {
  const userId = await getUserIdFromToken(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  const { solana_wallet_address } = await c.req.json();
  if (!solana_wallet_address) return c.json({ error: "solana_wallet_address required" }, 400);
  const { error } = await supabaseAdmin.from("profiles").update({ solana_wallet_address }).eq("user_id", userId);
  if (error) return c.json({ error: "DB error" }, 500);
  invalidateCache(userId);
  return c.json({ success: true });
});

// Save Stellar wallet address
app.put("/api/profile/stellar-wallet", async (c) => {
  const userId = await getUserIdFromToken(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  const { stellar_wallet_address } = await c.req.json();
  if (!stellar_wallet_address) return c.json({ error: "stellar_wallet_address required" }, 400);
  const { error } = await supabaseAdmin.from("profiles").update({ stellar_wallet_address }).eq("user_id", userId);
  if (error) return c.json({ error: "DB error" }, 500);
  invalidateCache(userId);
  return c.json({ success: true });
});

// Free endpoint - create checkout session from cart
app.post("/api/checkout", async (c) => {
  try {
    const body = await c.req.json() as {
      owner_id: string;
      items: Array<{ product_id: string; qty?: number }>;
    };

    const { owner_id, items } = body;
    if (!owner_id || !Array.isArray(items) || items.length === 0) {
      return c.json({ error: "owner_id and non-empty items[] required" }, 400);
    }

    const productIds = [...new Set(items.map(i => i.product_id))];

    const { data: products, error: productError } = await supabaseAdmin
      .from("products")
      .select("id, name, pricing, owner_id")
      .in("id", productIds);

    if (productError || !products?.length) {
      return c.json({ error: "Failed to fetch products" }, 400);
    }

    // Reject if any product not found
    if (products.length !== productIds.length) {
      const foundIds = new Set(products.map((p: any) => p.id));
      const missing = productIds.filter(id => !foundIds.has(id));
      return c.json({ error: `Products not found: ${missing.join(", ")}` }, 404);
    }

    // Reject mixed-merchant carts
    const ownerIds = new Set(products.map((p: any) => p.owner_id));
    if (ownerIds.size > 1) {
      return c.json({ error: "All products must belong to the same merchant" }, 400);
    }
    const resolvedOwnerId = products[0].owner_id;
    if (resolvedOwnerId !== owner_id) {
      return c.json({ error: "owner_id does not match product ownership" }, 400);
    }

    const productMap = new Map(products.map((p: any) => [p.id, p]));
    let total = 0;
    const lineItems = items.map(item => {
      const product = productMap.get(item.product_id) as any;
      const qty = Math.max(1, Math.floor(item.qty ?? 1));
      const subtotal = Number(product.pricing) * qty;
      total += subtotal;
      return {
        product_id: product.id,
        name: product.name,
        unit_price: Number(product.pricing),
        qty,
        subtotal,
      };
    });

    total = Math.round(total * 100) / 100;

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { data: checkout, error: insertError } = await supabaseAdmin
      .from("checkouts")
      .insert({
        owner_id: resolvedOwnerId,
        total_amount: total,
        currency: "USD",
        line_items: lineItems,
        expires_at: expiresAt,
        status: "pending",
      })
      .select("id, total_amount, currency, line_items, expires_at")
      .single();

    if (insertError || !checkout) {
      console.error("❌ Failed to create checkout:", insertError);
      return c.json({ error: "Failed to create checkout" }, 500);
    }

    return c.json({
      success: true,
      checkout_id: checkout.id,
      total: checkout.total_amount,
      currency: checkout.currency,
      line_items: checkout.line_items,
      expires_at: checkout.expires_at,
    }, 201);
  } catch (err: any) {
    console.error("❌ /api/checkout error:", err);
    return c.json({ error: "Invalid request" }, 400);
  }
});

// Paid endpoint - pay for a checkout session
app.post("/api/checkout/pay", async (c) => {
  try {
    const checkoutId = c.req.header("X-Checkout-Id");
    if (!checkoutId) return c.json({ error: "X-Checkout-Id header required" }, 400);

    const { data: checkout, error: fetchError } = await supabaseAdmin
      .from("checkouts")
      .select("id, owner_id, total_amount, currency, line_items, status, expires_at")
      .eq("id", checkoutId)
      .single();

    if (fetchError || !checkout) return c.json({ error: "Checkout not found" }, 404);
    if (checkout.status !== "pending") return c.json({ error: "Checkout already paid or expired" }, 409);

    // Mark as paid (idempotency guard)
    const { error: updateError } = await supabaseAdmin
      .from("checkouts")
      .update({ status: "paid" })
      .eq("id", checkoutId)
      .eq("status", "pending");

    if (updateError) return c.json({ error: "Failed to settle checkout" }, 500);

    const sessionId = uuidv4();
    c.set("lastSessionId", sessionId);

    try {
      const paymentHeader = c.req.header("payment-signature") || c.req.header("x-payment");
      let walletAddress: string | undefined;
      if (paymentHeader) {
        try {
          const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
          walletAddress = decoded?.payload?.authorization?.from;
        } catch {}
      }

      await recordSuccessfulPayment({
        owner_id: checkout.owner_id,
        amount: Number(checkout.total_amount),
        currency: checkout.currency,
        crypto_amount: Number(checkout.total_amount),
        crypto_currency: "USDC",
        wallet_address: walletAddress,
        session_id: sessionId,
      });

      // Patch checkout_id onto the transaction after recording
      await supabaseAdmin
        .from("transactions")
        .update({ checkout_id: checkoutId })
        .eq("session_id", sessionId);
    } catch (recordErr: any) {
      console.error("❌ Failed to record checkout transaction:", recordErr.message);
    }

    return c.json({
      success: true,
      checkout_id: checkoutId,
      session_id: sessionId,
      total: checkout.total_amount,
      currency: checkout.currency,
      purchased: checkout.line_items,
    });
  } catch (err: any) {
    console.error("❌ /api/checkout/pay error:", err);
    return c.json({ error: "Payment failed" }, 500);
  }
});

// Free endpoint - get checkout details + merchant payment options (no auth needed)
app.get("/api/checkout/:id/payment-options", async (c) => {
  try {
    const checkoutId = c.req.param("id");

    const { data: checkout, error: checkoutError } = await supabaseAdmin
      .from("checkouts")
      .select("id, owner_id, total_amount, currency, line_items, expires_at, status")
      .eq("id", checkoutId)
      .single();

    if (checkoutError || !checkout) {
      return c.json({ error: "Checkout not found" }, 404);
    }

    if (checkout.status !== "pending") {
      return c.json({ error: "Checkout already paid or expired" }, 409);
    }

    if (new Date() > new Date(checkout.expires_at)) {
      await supabaseAdmin.from("checkouts").update({ status: "expired" }).eq("id", checkoutId);
      return c.json({ error: "Checkout expired" }, 410);
    }

    const [{ data: profile }, { data: configs }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("wallet_address, solana_wallet_address, stellar_wallet_address")
        .eq("user_id", checkout.owner_id)
        .single(),
      supabaseAdmin
        .from("merchant_payment_configs")
        .select("chain_id, token_symbol, asset, enabled")
        .eq("owner_id", checkout.owner_id)
        .eq("enabled", true),
    ]);

    const payment_options = (configs ?? [])
      .map((cfg: any) => {
        const token = getTokenConfig(cfg.chain_id, cfg.token_symbol);
        if (!token) return null;

        let payTo: string | null = null;
        if (token.chainFamily === "evm") payTo = profile?.wallet_address ?? null;
        else if (token.chainFamily === "solana") payTo = profile?.solana_wallet_address ?? null;
        else if (token.chainFamily === "stellar") payTo = profile?.stellar_wallet_address ?? null;
        if (!payTo) return null;

        return {
          chain_id: token.chainId,
          chain_name: token.chainName,
          chain_family: token.chainFamily,
          network: token.network,
          token_symbol: token.tokenSymbol,
          token_name: token.tokenName,
          asset: token.asset,
          is_testnet: token.isTestnet,
          pay_to: payTo,
        };
      })
      .filter(Boolean);

    return c.json({
      success: true,
      checkout: {
        id: checkout.id,
        total: checkout.total_amount,
        currency: checkout.currency,
        line_items: checkout.line_items,
        expires_at: checkout.expires_at,
        status: checkout.status,
      },
      payment_options,
    });
  } catch (err: any) {
    console.error("❌ /api/checkout/:id/payment-options error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Free endpoint - health check
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    message: "Server is running",
    config: {
      network,
      payTo,
      facilitator: facilitatorUrl,
    },
  });
});

// Free endpoint - get wallet risk analysis from analysis-engine
app.get("/api/risk/wallet/:address", async (c) => {
  const address = c.req.param("address");
  const ANALYSIS_ENGINE_URL = process.env.ANALYSIS_ENGINE_URL || "http://localhost:3002";

  try {
    console.log(`📡 Forwarding risk analysis request for wallet: ${address}`);

    const response = await fetch(`${ANALYSIS_ENGINE_URL}/api/risk/wallet/${address}`);
    const data = await response.json();

    return c.json(data);
  } catch (error: any) {
    console.error("❌ Failed to fetch risk analysis:", error.message);
    return c.json({
      success: false,
      error: "Failed to fetch wallet risk analysis",
      message: error.message
    }, 500);
  }
});

// Free endpoint - get payment options
app.get("/api/payment-options", (c) => {
  return c.json({
    options: [
      {
        name: "24-Hour Access",
        endpoint: "/api/pay/session",
        price: "$1.00",
        description: "Get a session ID for 24 hours of unlimited access",
      },
      {
        name: "One-Time Access",
        endpoint: "/api/pay/onetime",
        price: "$0.10",
        description: "Single use payment for immediate access",
      },
    ],
  });
});

// Paid endpoint - 24-hour session access ($1.00)
app.post("/api/pay/session", async (c) => {
  try {
    const sessionId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

    const session: Session = {
      id: sessionId,
      createdAt: now,
      expiresAt,
      type: "24hour",
    };

    sessions.set(sessionId, session);
    c.set('lastSessionId', sessionId);

    // Record successful transaction
    try {
      // x402 v2 sends payment-signature; extract wallet from it
      const paymentHeader = c.req.header('payment-signature') || c.req.header('x-payment');
      let walletAddress: string | undefined;
      if (paymentHeader) {
        try {
          const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
          walletAddress = decoded?.payload?.authorization?.from;
        } catch {}
      }

      const paymentLinkHash = extractPaymentLinkFromContext(c);
      let payment_link_id: string | undefined;
      let owner_id: string | null = null;

      if (paymentLinkHash) {
        const linkData = await getPaymentLinkData(paymentLinkHash);
        if (linkData) {
          payment_link_id = linkData.id;
          owner_id = linkData.owner_id;
        }
      }

      if (!owner_id) {
        owner_id = await getSystemOwnerId(payTo);
      }

      if (owner_id) {
        await recordSuccessfulPayment({
          owner_id,
          payment_link_id,
          amount: 1.0,
          currency: 'USD',
          crypto_amount: 1.0,
          crypto_currency: 'USDC',
          wallet_address: walletAddress,
          session_id: sessionId,
        });
      } else {
        console.error('❌ Cannot record transaction: No valid owner_id found');
      }
    } catch (recordError: any) {
      console.error('❌ Failed to record successful transaction:', recordError.message);
    }

    return c.json({
      success: true,
      sessionId,
      message: "24-hour access granted!",
      session: {
        id: sessionId,
        type: "24hour",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        validFor: "24 hours",
      },
    });
  } catch (error: any) {
    console.error('❌ Payment failed:', error);
    return c.json({
      success: false,
      error: 'Payment failed',
      message: error.message,
    }, 500);
  }
});

// Paid endpoint - one-time access/payment ($0.10)
app.post("/api/pay/onetime", async (c) => {
  try {
    const sessionId = uuidv4();
    const now = new Date();

    const session: Session = {
      id: sessionId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000), // 5 minutes to use
      type: "onetime",
      used: false,
    };

    sessions.set(sessionId, session);
    c.set('lastSessionId', sessionId);

    // Record successful transaction
    try {
      // x402 v2 sends payment-signature; extract wallet from it
      const paymentHeader = c.req.header('payment-signature') || c.req.header('x-payment');
      let walletAddress: string | undefined;
      if (paymentHeader) {
        try {
          const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
          walletAddress = decoded?.payload?.authorization?.from;
        } catch {}
      }

      const paymentLinkHash = extractPaymentLinkFromContext(c);
      let payment_link_id: string | undefined;
      let owner_id: string | null = null;

      if (paymentLinkHash) {
        const linkData = await getPaymentLinkData(paymentLinkHash);
        if (linkData) {
          payment_link_id = linkData.id;
          owner_id = linkData.owner_id;
        }
      }

      if (!owner_id) {
        owner_id = await getSystemOwnerId(payTo);
      }

      if (owner_id) {
        await recordSuccessfulPayment({
          owner_id,
          payment_link_id,
          amount: 0.10,
          currency: 'USD',
          crypto_amount: 0.10,
          crypto_currency: 'USDC',
          wallet_address: walletAddress,
          session_id: sessionId,
        });
      } else {
        console.error('❌ Cannot record transaction: No valid owner_id found');
      }
    } catch (recordError: any) {
      console.error('❌ Failed to record successful transaction:', recordError.message);
    }

    return c.json({
      success: true,
      sessionId,
      message: "One-time access granted!",
      access: {
        id: sessionId,
        type: "onetime",
        createdAt: now.toISOString(),
        validFor: "5 minutes (single use)",
      },
    });
  } catch (error: any) {
    console.error('❌ Payment failed:', error);
    return c.json({
      success: false,
      error: 'Payment failed',
      message: error.message,
    }, 500);
  }
});

// Free endpoint - validate session
app.get("/api/session/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);

  if (!session) {
    return c.json({ valid: false, error: "Session not found" }, 404);
  }

  const now = new Date();
  const isExpired = now > session.expiresAt;
  const isUsed = session.type === "onetime" && session.used;

  if (isExpired || isUsed) {
    return c.json({ 
      valid: false, 
      error: isExpired ? "Session expired" : "One-time access already used",
      session: {
        id: session.id,
        type: session.type,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        used: session.used,
      }
    });
  }

  // Mark one-time sessions as used
  if (session.type === "onetime") {
    session.used = true;
    sessions.set(sessionId, session);
  }

  return c.json({
    valid: true,
    session: {
      id: session.id,
      type: session.type,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      remainingTime: session.expiresAt.getTime() - now.getTime(),
    },
  });
});

// Free endpoint - list active sessions (for demo purposes)
app.get("/api/sessions", (c) => {
  const activeSessions = Array.from(sessions.values())
    .filter(session => {
      const isExpired = new Date() > session.expiresAt;
      const isUsed = session.type === "onetime" && session.used;
      return !isExpired && !isUsed;
    })
    .map(session => ({
      id: session.id,
      type: session.type,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    }));

  return c.json({ sessions: activeSessions });
});

// Product interface
interface Product {
  id: string; // UUID generated by Supabase
  name: string;
  pricing: number;
  created_at: string;
  updated_at: string;
}

// GET all products
app.get("/api/products", async (c) => {
  try {
    // Get user ID from JWT token
    const userId = await getUserIdFromToken(c);
    if (!userId) {
      return c.json({ 
        success: false, 
        error: "Authentication required" 
      }, 401);
    }

    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error:', error);
      return c.json({ 
        success: false, 
        error: "Failed to fetch products" 
      }, 500);
    }

    return c.json({ 
      success: true,
      products: products || [] 
    });
  } catch (error) {
    console.error('Server error:', error);
    return c.json({ 
      success: false, 
      error: "Internal server error" 
    }, 500);
  }
});

// POST to add a product
app.post("/api/product", async (c) => {
  try {
    // Get user ID from JWT token
    const userId = await getUserIdFromToken(c);
    if (!userId) {
      return c.json({
        success: false,
        error: "Authentication required"
      }, 401);
    }

    const body = await c.req.json();
    const { name, pricing } = body;

    if (!name || typeof pricing !== 'number') {
      return c.json({ 
        success: false, 
        error: "Missing required fields: name (string) and pricing (number)" 
      }, 400);
    }

    // Extra safety check before database insert
    if (!userId) {
      console.error('❌ CRITICAL: userId is null at insert time');
      return c.json({
        success: false,
        error: "Authentication required"
      }, 401);
    }

    const now = new Date().toISOString();
    const newProduct = {
      owner_id: userId,
      name,
      pricing,
      created_at: now,
      updated_at: now,
    };

    const { error } = await supabaseAdmin
      .from('products')
      .insert([newProduct]);

    if (error) {
      console.error('Supabase error:', error);
      if (error.code === '23505') { // Unique constraint violation
        return c.json({
          success: false,
          error: "Product with this ID already exists"
        }, 409);
      }
      return c.json({
        success: false,
        error: "Failed to create product"
      }, 500);
    }

    // Product created successfully - return the data we sent
    // (ID is auto-generated by Supabase, but we don't need it in the response)
    return c.json({
      success: true,
      message: "Product created successfully",
      product: newProduct,
    }, 201);
  } catch (error) {
    console.error('Server error:', error);
    return c.json({ 
      success: false, 
      error: "Invalid JSON in request body" 
    }, 400);
  }
});

// Payment Link interface
interface PaymentLink {
  id: string; // UUID generated by Supabase
  link_name: string;
  payment_link: string; // Unique hash generated from product_id and id
  product_id: string;
  product_name: string; // Flattened from products.name
  pricing: number;
  expiry_date: string;
  created_at: string;
  updated_at: string;
  products: {
    name: string;
  };
}

// GET all payment links
app.get("/api/payment-links", async (c) => {
  try {
    // Get user ID from JWT token
    const userId = await getUserIdFromToken(c);
    if (!userId) {
      return c.json({ 
        success: false, 
        error: "Authentication required" 
      }, 401);
    }

    const { data: paymentLinks, error } = await supabaseAdmin
      .from('payment_links')
      .select(`
        *,
        products!inner(name)
      `)
      .eq('owner_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error:', error);
      return c.json({ 
        success: false, 
        error: "Failed to fetch payment links" 
      }, 500);
    }

    // Transform the response to flatten product name
    const transformedPaymentLinks = (paymentLinks || []).map(link => ({
      ...link,
      product_name: link.products.name
    }));

    return c.json({ 
      success: true,
      payment_links: transformedPaymentLinks 
    });
  } catch (error) {
    console.error('Server error:', error);
    return c.json({ 
      success: false, 
      error: "Internal server error" 
    }, 500);
  }
});

// POST to add a payment link
app.post("/api/payment-link", async (c) => {
  try {
    // Get user ID from JWT token
    const userId = await getUserIdFromToken(c);
    if (!userId) {
      return c.json({ 
        success: false, 
        error: "Authentication required" 
      }, 401);
    }

    const body = await c.req.json();
    const { link_name, product_name, expiry_date } = body;

    if (!link_name || !product_name || !expiry_date) {
      return c.json({ 
        success: false, 
        error: "Missing required fields: link_name (string), product_name (string), and expiry_date (ISO string)" 
      }, 400);
    }

    // Validate expiry_date format
    const expiryDate = new Date(expiry_date);
    if (isNaN(expiryDate.getTime())) {
      return c.json({ 
        success: false, 
        error: "Invalid expiry_date format. Use ISO date string (e.g., '2024-12-31T23:59:59.000Z')" 
      }, 400);
    }

    // Check if expiry_date is in the future
    if (expiryDate <= new Date()) {
      return c.json({ 
        success: false, 
        error: "expiry_date must be in the future" 
      }, 400);
    }

    // First, get the product details by name and owner
    const { data: products, error: productError } = await supabaseAdmin
      .from('products')
      .select('id, name, pricing')
      .eq('name', product_name)
      .eq('owner_id', userId)
      .limit(1);

    if (productError || !products || products.length === 0) {
      return c.json({
        success: false,
        error: `Product with name '${product_name}' not found`
      }, 404);
    }

    const product = products[0];

    const now = new Date().toISOString();

    // Generate a unique payment link hash using product_id, timestamp, and random value
    const hashInput = product.id + Date.now().toString() + Math.random().toString();
    const hash = createHash('md5').update(hashInput).digest('hex');
    const paymentLinkHash = 'pay_' + hash.substring(0, 16);

    // Insert the payment link with the final hash
    const paymentLink = {
      owner_id: userId,
      link_name,
      payment_link: paymentLinkHash,
      product_id: product.id,
      pricing: product.pricing,
      expiry_date: expiryDate.toISOString(),
      created_at: now,
      updated_at: now,
    };

    const { error: insertError } = await supabaseAdmin
      .from('payment_links')
      .insert([paymentLink]);

    if (insertError) {
      console.error('Supabase error:', insertError);
      return c.json({
        success: false,
        error: "Failed to create payment link"
      }, 500);
    }

    return c.json({
      success: true,
      message: "Payment link created successfully",
      payment_link: paymentLink,
    }, 201);
  } catch (error) {
    console.error('Server error:', error);
    return c.json({ 
      success: false, 
      error: "Invalid JSON in request body" 
    }, 400);
  }
});

// GET payment link details by payment_link hash
app.get("/api/payment-link/:paymentLink", async (c) => {
  try {
    const paymentLink = c.req.param("paymentLink");

    const { data: paymentLinkData, error } = await supabaseAdmin
      .from('payment_links')
      .select('*')
      .eq('payment_link', paymentLink)
      .single();

    if (error || !paymentLinkData) {
      return c.json({
        success: false,
        error: "Payment link not found"
      }, 404);
    }

    // Check if payment link has expired
    const now = new Date();
    const expiryDate = new Date(paymentLinkData.expiry_date);

    if (now > expiryDate) {
      return c.json({
        success: false,
        error: "Payment link has expired"
      }, 410);
    }

    // Fetch the product name from products table
    const { data: product, error: productError } = await supabaseAdmin
      .from('products')
      .select('name')
      .eq('id', paymentLinkData.product_id)
      .single();

    // Add product_name to the response
    const responseData = {
      ...paymentLinkData,
      product_name: product?.name || paymentLinkData.link_name
    };

    return c.json({
      success: true,
      payment_link: responseData
    });
  } catch (error) {
    console.error('Server error:', error);
    return c.json({
      success: false,
      error: "Internal server error"
    }, 500);
  }
});

// GET all transactions with optional filters
app.get("/api/transactions", async (c) => {
  try {
    // Get user ID from JWT token
    const userId = await getUserIdFromToken(c);
    if (!userId) {
      return c.json({
        success: false,
        error: "Authentication required"
      }, 401);
    }

    // Get query parameters for filtering and pagination
    const status = c.req.query('status'); // 'pending', 'processing', 'completed', 'failed', 'blocked', 'cancelled'
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    // Build query
    let query = supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply status filter if provided
    if (status) {
      query = query.eq('status', status);
    }

    const { data: transactions, error, count } = await query;

    if (error) {
      console.error('Supabase error:', error);
      return c.json({
        success: false,
        error: "Failed to fetch transactions"
      }, 500);
    }

    // Calculate summary statistics
    const { data: allTransactions } = await supabaseAdmin
      .from('transactions')
      .select('status, amount')
      .eq('owner_id', userId);

    const stats = {
      total: allTransactions?.length || 0,
      processing: allTransactions?.filter(t => t.status === 'processing').length || 0,
      completed: allTransactions?.filter(t => t.status === 'completed').length || 0,
      pending: allTransactions?.filter(t => t.status === 'pending').length || 0,
      failed: allTransactions?.filter(t => t.status === 'failed').length || 0,
      blocked: allTransactions?.filter(t => t.status === 'blocked').length || 0,
      cancelled: allTransactions?.filter(t => t.status === 'cancelled').length || 0,
      totalAmount: allTransactions
        ?.filter(t => t.status === 'processing')
        .reduce((sum, t) => sum + (t.amount || 0), 0) || 0,
    };

    return c.json({
      success: true,
      transactions: transactions || [],
      count: count || 0,
      stats,
      pagination: {
        limit,
        offset,
        hasMore: (count || 0) > offset + limit
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    return c.json({
      success: false,
      error: "Internal server error"
    }, 500);
  }
});

console.log(`
🚀 x402 Payment Template Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 Accepting payments to: ${payTo}
🔗 Network: ${network}
🌐 Port: ${port}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Payment Options:
   - 24-Hour Session: $1.00
   - One-Time Access: $0.10
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛠️  This is a template! Customize it for your app.
📚 Learn more: https://x402.org
💬 Get help: https://discord.gg/invite/cdp
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

const stopPoller = startConfirmationPoller(
  parseInt(process.env.POLL_INTERVAL_MS ?? '15000')
);
process.on('SIGTERM', () => { stopPoller(); process.exit(0); });
process.on('SIGINT',  () => { stopPoller(); process.exit(0); });

serve({
  fetch: app.fetch,
  port,
}); 