import { Hono } from "hono";
import { clerkAuthMiddleware, getMerchant } from "../middleware/clerkAuth";
import { supabaseAdmin } from "../lib/supabase";

const app = new Hono();

app.use("/api/balance*", clerkAuthMiddleware);

// GET /api/balance — list all balance rows for this merchant
app.get("/api/balance", async (c) => {
  const { profileId } = getMerchant(c);

  const { data: balances, error } = await supabaseAdmin
    .from("balances")
    .select("*")
    .eq("owner_id", profileId)
    .order("updated_at", { ascending: false });

  if (error) return c.json({ success: false, error: "Failed to fetch balances" }, 500);

  const rows = balances ?? [];
  const totalUSD = rows.reduce((s, b) => s + (Number(b.usd_value) || 0), 0);

  return c.json({
    success: true,
    balances: rows,
    total_usd: Math.round(totalUSD * 100) / 100,
  });
});

// POST /api/balance/sync — upsert a balance row (call after receiving a payment)
app.post("/api/balance/sync", async (c) => {
  const { profileId } = getMerchant(c);

  const body = await c.req.json() as {
    currency: string;
    chain_id: string;
    amount: number;
    usd_value?: number;
  };

  const { currency, chain_id, amount, usd_value } = body;
  if (!currency || !chain_id || amount == null)
    return c.json({ error: "currency, chain_id, and amount are required" }, 400);

  const { data, error } = await supabaseAdmin
    .from("balances")
    .upsert(
      {
        owner_id: profileId,
        currency,
        chain_id,
        amount,
        usd_value: usd_value ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,currency,chain_id" }
    )
    .select()
    .single();

  if (error) return c.json({ success: false, error: "Failed to sync balance" }, 500);

  return c.json({ success: true, balance: data });
});

export default app;
