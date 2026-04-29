import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { clerkAuthMiddleware, getMerchant } from "../middleware/clerkAuth";
import { supabaseAdmin } from "../lib/supabase";
import { getTokenConfig } from "../tokenRegistry";
import { recordSuccessfulPayment } from "../services/transactionService";

type Vars = { merchant?: unknown; lastSessionId?: string };
const app = new Hono<{ Variables: Vars }>();

// ── Authenticated: create checkout session ────────────────────────────────────
app.post("/api/checkout", clerkAuthMiddleware, async (c) => {
  try {
    const { profileId } = getMerchant(c);
    const body = await c.req.json() as {
      items: Array<{ product_id: string; qty?: number }>;
      success_url?: string;
      cancel_url?: string;
      metadata?: Record<string, unknown>;
      currency?: string;
      expires_in_minutes?: number;
    };

    const { items, success_url, cancel_url, metadata, currency = "USD", expires_in_minutes = 30 } = body;
    if (!Array.isArray(items) || items.length === 0)
      return c.json({ error: "items[] is required and must not be empty" }, 400);

    const productIds = [...new Set(items.map(i => i.product_id))];
    const { data: products, error: productError } = await supabaseAdmin
      .from("products")
      .select("id, name, pricing, owner_id")
      .in("id", productIds);

    if (productError || !products?.length)
      return c.json({ error: "Failed to fetch products" }, 400);

    if (products.length !== productIds.length) {
      const found = new Set(products.map((p: any) => p.id));
      const missing = productIds.filter(id => !found.has(id));
      return c.json({ error: `Products not found: ${missing.join(", ")}` }, 404);
    }

    // All products must belong to this merchant
    const wrongOwner = products.filter((p: any) => p.owner_id !== profileId);
    if (wrongOwner.length > 0)
      return c.json({ error: "All products must belong to your account" }, 403);

    const productMap = new Map(products.map((p: any) => [p.id, p]));
    let total = 0;
    const lineItems = items.map(item => {
      const product = productMap.get(item.product_id) as any;
      const qty = Math.max(1, Math.floor(item.qty ?? 1));
      const subtotal = Math.round(Number(product.pricing) * qty * 100) / 100;
      total += subtotal;
      return { product_id: product.id, name: product.name, unit_price: Number(product.pricing), qty, subtotal };
    });
    total = Math.round(total * 100) / 100;

    const expiresAt = new Date(Date.now() + expires_in_minutes * 60 * 1000).toISOString();
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5174";

    const { data: checkout, error: insertError } = await supabaseAdmin
      .from("checkouts")
      .insert({
        owner_id: profileId,
        total_amount: total,
        currency,
        line_items: lineItems,
        success_url: success_url ?? null,
        cancel_url: cancel_url ?? null,
        metadata: metadata ?? null,
        expires_at: expiresAt,
        status: "pending",
      })
      .select("id, total_amount, currency, line_items, expires_at, status")
      .single();

    if (insertError || !checkout) {
      console.error("❌ Failed to create checkout:", insertError);
      return c.json({ error: "Failed to create checkout" }, 500);
    }

    return c.json({
      success: true,
      checkout_id: checkout.id,
      checkout_url: `${frontendUrl}/c/${checkout.id}`,
      total: checkout.total_amount,
      currency: checkout.currency,
      line_items: checkout.line_items,
      expires_at: checkout.expires_at,
      status: checkout.status,
    }, 201);
  } catch (err: any) {
    console.error("❌ POST /api/checkout:", err);
    return c.json({ error: "Invalid request" }, 400);
  }
});

// ── Authenticated: list merchant's checkout sessions ─────────────────────────
app.get("/api/checkouts", clerkAuthMiddleware, async (c) => {
  const { profileId } = getMerchant(c);
  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  let query = supabaseAdmin
    .from("checkouts")
    .select("*", { count: "exact" })
    .eq("owner_id", profileId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);

  const { data: checkouts, error, count } = await query;
  if (error) return c.json({ error: "Failed to fetch checkouts" }, 500);

  const { data: allCheckouts } = await supabaseAdmin
    .from("checkouts")
    .select("status, total_amount")
    .eq("owner_id", profileId);

  const stats = {
    pending: allCheckouts?.filter(c => c.status === "pending").length ?? 0,
    paid: allCheckouts?.filter(c => c.status === "paid").length ?? 0,
    expired: allCheckouts?.filter(c => c.status === "expired").length ?? 0,
    cancelled: allCheckouts?.filter(c => c.status === "cancelled").length ?? 0,
    total_revenue: allCheckouts
      ?.filter(c => c.status === "paid")
      .reduce((s, c) => s + Number(c.total_amount), 0) ?? 0,
  };

  return c.json({
    success: true,
    checkouts: checkouts ?? [],
    count: count ?? 0,
    stats,
    pagination: { limit, offset, has_more: (count ?? 0) > offset + limit },
  });
});

// ── Authenticated: get single checkout ───────────────────────────────────────
app.get("/api/checkout/:id", clerkAuthMiddleware, async (c) => {
  const { profileId } = getMerchant(c);
  const checkoutId = c.req.param("id");

  const { data: checkout, error } = await supabaseAdmin
    .from("checkouts")
    .select("*")
    .eq("id", checkoutId)
    .eq("owner_id", profileId)
    .single();

  if (error || !checkout) return c.json({ error: "Checkout not found" }, 404);

  // Attach linked transaction if paid
  let transaction = null;
  if (checkout.status === "paid") {
    const { data: tx } = await supabaseAdmin
      .from("transactions")
      .select("id, tx_hash, network, wallet_address, crypto_amount, crypto_currency")
      .eq("checkout_id", checkoutId)
      .single();
    transaction = tx ?? null;
  }

  return c.json({ success: true, checkout, transaction });
});

// ── Authenticated: expire a checkout manually ─────────────────────────────────
app.post("/api/checkout/:id/expire", clerkAuthMiddleware, async (c) => {
  const { profileId } = getMerchant(c);
  const checkoutId = c.req.param("id");

  const { data: checkout } = await supabaseAdmin
    .from("checkouts")
    .select("id, status")
    .eq("id", checkoutId)
    .eq("owner_id", profileId)
    .single();

  if (!checkout) return c.json({ error: "Checkout not found" }, 404);
  if (checkout.status !== "pending") return c.json({ error: "Only pending checkouts can be expired" }, 409);

  await supabaseAdmin.from("checkouts").update({ status: "expired" }).eq("id", checkoutId);
  return c.json({ success: true });
});

// ── Public: payment options for consumer payment page ─────────────────────────
app.get("/api/checkout/:id/payment-options", async (c) => {
  try {
    const checkoutId = c.req.param("id");

    const { data: checkout, error: checkoutError } = await supabaseAdmin
      .from("checkouts")
      .select("id, owner_id, total_amount, currency, line_items, expires_at, status")
      .eq("id", checkoutId)
      .single();

    if (checkoutError || !checkout) return c.json({ error: "Checkout not found" }, 404);

    if (checkout.status === "paid") return c.json({ error: "Checkout already paid" }, 409);

    if (checkout.status !== "pending") return c.json({ error: "Checkout is not active" }, 409);

    if (new Date() > new Date(checkout.expires_at)) {
      await supabaseAdmin.from("checkouts").update({ status: "expired" }).eq("id", checkoutId);
      return c.json({ error: "Checkout expired" }, 410);
    }

    const [{ data: profile }, { data: configs }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("display_name, wallet_address, solana_wallet_address, stellar_wallet_address")
        .eq("id", checkout.owner_id)
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
      merchant: { display_name: profile?.display_name ?? "Merchant" },
      payment_options,
    });
  } catch (err: any) {
    console.error("❌ GET /api/checkout/:id/payment-options:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Public + x402: pay for a checkout (middleware applied in index.ts) ────────
app.post("/api/checkout/pay", async (c) => {
  try {
    const checkoutId = c.req.header("X-Checkout-Id");
    if (!checkoutId) return c.json({ error: "X-Checkout-Id header required" }, 400);

    const { data: checkout, error: fetchError } = await supabaseAdmin
      .from("checkouts")
      .select("id, owner_id, total_amount, currency, line_items, status, expires_at, success_url")
      .eq("id", checkoutId)
      .single();

    if (fetchError || !checkout) return c.json({ error: "Checkout not found" }, 404);
    if (checkout.status !== "pending") return c.json({ error: "Checkout already paid or expired" }, 409);

    // Idempotency guard — atomic status update
    const { error: updateError } = await supabaseAdmin
      .from("checkouts")
      .update({ status: "paid", paid_at: new Date().toISOString() })
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

      const { data: txResult } = await recordSuccessfulPayment({
        owner_id: checkout.owner_id,
        amount: Number(checkout.total_amount),
        currency: checkout.currency,
        crypto_amount: Number(checkout.total_amount),
        crypto_currency: "USDC",
        wallet_address: walletAddress,
        session_id: sessionId,
      }) as any;

      if (txResult?.transaction_id) {
        await supabaseAdmin
          .from("transactions")
          .update({ checkout_id: checkoutId })
          .eq("id", txResult.transaction_id);
      } else {
        // Fallback: patch by session_id
        await supabaseAdmin
          .from("transactions")
          .update({ checkout_id: checkoutId })
          .eq("session_id", sessionId);
      }
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
      redirect_url: checkout.success_url ?? null,
    });
  } catch (err: any) {
    console.error("❌ POST /api/checkout/pay:", err);
    return c.json({ error: "Payment failed" }, 500);
  }
});

export default app;
