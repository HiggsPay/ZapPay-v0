import { Hono } from "hono";
import { createHmac } from "crypto";
import { clerkAuthMiddleware, getMerchant } from "../middleware/clerkAuth";
import { supabaseAdmin } from "../lib/supabase";
import { invalidateCache } from "../middleware/dynamicPaymentMiddleware";

const app = new Hono();

app.use("/api/profile", clerkAuthMiddleware);
app.use("/api/profile/*", clerkAuthMiddleware);

app.get("/api/profile", async (c) => {
  const { profileId } = getMerchant(c);
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, email, display_name, wallet_address, solana_wallet_address, stellar_wallet_address, api_key, plan, webhook_url")
    .eq("id", profileId)
    .single();
  if (error || !data) return c.json({ error: "Profile not found" }, 404);
  return c.json({ success: true, profile: data });
});

app.put("/api/profile/wallet", async (c) => {
  const { profileId } = getMerchant(c);
  const { wallet_address } = await c.req.json();
  if (!wallet_address?.match(/^0x[0-9a-fA-F]{40}$/))
    return c.json({ error: "Invalid Ethereum address" }, 400);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ wallet_address })
    .eq("id", profileId);
  if (error) return c.json({ error: "DB error" }, 500);
  invalidateCache(profileId);
  return c.json({ success: true });
});

app.put("/api/profile/solana-wallet", async (c) => {
  const { profileId } = getMerchant(c);
  const { solana_wallet_address } = await c.req.json();
  if (!solana_wallet_address) return c.json({ error: "solana_wallet_address required" }, 400);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ solana_wallet_address })
    .eq("id", profileId);
  if (error) return c.json({ error: "DB error" }, 500);
  invalidateCache(profileId);
  return c.json({ success: true });
});

app.put("/api/profile/stellar-wallet", async (c) => {
  const { profileId } = getMerchant(c);
  const { stellar_wallet_address } = await c.req.json();
  if (!stellar_wallet_address) return c.json({ error: "stellar_wallet_address required" }, 400);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ stellar_wallet_address })
    .eq("id", profileId);
  if (error) return c.json({ error: "DB error" }, 500);
  invalidateCache(profileId);
  return c.json({ success: true });
});

// ── Webhook configuration ──────────────────────────────────────────────────────

app.put("/api/profile/webhook", async (c) => {
  const { profileId } = getMerchant(c);
  const body = await c.req.json();
  const { webhook_url } = body;

  if (webhook_url === undefined) return c.json({ error: "webhook_url is required" }, 400);

  if (webhook_url !== null && webhook_url !== "") {
    let parsed: URL;
    try {
      parsed = new URL(webhook_url);
    } catch {
      return c.json({ error: "webhook_url must be a valid URL" }, 400);
    }
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost))
      return c.json({ error: "webhook_url must use https:// (http:// allowed for localhost only)" }, 400);
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ webhook_url: webhook_url || null })
    .eq("id", profileId);
  if (error) return c.json({ error: "DB error" }, 500);
  return c.json({ success: true });
});

app.get("/api/profile/webhook-secret", async (c) => {
  const { profileId } = getMerchant(c);
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("webhook_secret")
    .eq("id", profileId)
    .single();
  if (error || !data) return c.json({ error: "Profile not found" }, 404);
  return c.json({ success: true, webhook_secret: data.webhook_secret });
});

app.post("/api/profile/webhook/test", async (c) => {
  const { profileId } = getMerchant(c);
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("webhook_url, webhook_secret")
    .eq("id", profileId)
    .single();

  if (error || !data) return c.json({ error: "Profile not found" }, 404);
  if (!data.webhook_url || !data.webhook_secret)
    return c.json({ error: "No webhook URL configured" }, 400);

  const payload = {
    event: "transaction.confirmed",
    transaction_id: "00000000-0000-0000-0000-000000000000",
    tx_hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    network: "eip155:84532",
    amount: 1.00,
    currency: "USD",
    crypto_amount: 1.00,
    crypto_currency: "USDC",
    wallet_address: null,
    payment_link_id: null,
    payment_link_hash: null,
    owner_id: profileId,
    session_id: null,
    confirmed_at: new Date().toISOString(),
    _test: true,
  };

  const rawBody = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", data.webhook_secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");

  try {
    const response = await fetch(data.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZapPay-Signature": `sha256=${sig}`,
        "X-ZapPay-Timestamp": ts,
      },
      body: rawBody,
    });
    const ok = response.ok;
    const status = response.status;
    const text = await response.text().catch(() => "");
    return c.json({ ok, status, error: ok ? undefined : text.slice(0, 200) });
  } catch (err: any) {
    return c.json({ ok: false, status: 0, error: err.message });
  }
});

export default app;
