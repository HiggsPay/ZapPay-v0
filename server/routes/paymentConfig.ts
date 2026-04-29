import { Hono } from "hono";
import { clerkAuthMiddleware, getMerchant } from "../middleware/clerkAuth";
import { supabaseAdmin } from "../lib/supabase";
import { getTokenConfig } from "../tokenRegistry";
import { invalidateCache } from "../middleware/dynamicPaymentMiddleware";

const app = new Hono();

app.use("/api/payment-config", clerkAuthMiddleware);

app.get("/api/payment-config", async (c) => {
  const { profileId } = getMerchant(c);
  const { data, error } = await supabaseAdmin
    .from("merchant_payment_configs")
    .select("*")
    .eq("owner_id", profileId);
  if (error) return c.json({ error: "DB error" }, 500);
  return c.json({ success: true, configs: data });
});

app.put("/api/payment-config", async (c) => {
  const { profileId } = getMerchant(c);
  const body = await c.req.json() as { configs: Array<{ chain_id: string; token_symbol: string }> };
  const { configs } = body;
  if (!Array.isArray(configs)) return c.json({ error: "configs must be an array" }, 400);
  for (const entry of configs) {
    if (!getTokenConfig(entry.chain_id, entry.token_symbol))
      return c.json({ error: `Unsupported: ${entry.chain_id}/${entry.token_symbol}` }, 400);
  }
  await supabaseAdmin.from("merchant_payment_configs").delete().eq("owner_id", profileId);
  if (configs.length > 0) {
    const rows = configs.map(entry => {
      const token = getTokenConfig(entry.chain_id, entry.token_symbol)!;
      return {
        owner_id: profileId,
        chain_id: entry.chain_id,
        token_symbol: entry.token_symbol,
        asset: token.asset,
        enabled: true,
      };
    });
    const { error } = await supabaseAdmin.from("merchant_payment_configs").insert(rows);
    if (error) return c.json({ error: "DB error" }, 500);
  }
  invalidateCache(profileId);
  return c.json({ success: true });
});

export default app;
