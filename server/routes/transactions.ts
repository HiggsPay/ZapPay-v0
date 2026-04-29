import { Hono } from "hono";
import { clerkAuthMiddleware, getMerchant } from "../middleware/clerkAuth";
import { supabaseAdmin } from "../lib/supabase";

const app = new Hono();

app.use("/api/transactions", clerkAuthMiddleware);

app.get("/api/transactions", async (c) => {
  const { profileId } = getMerchant(c);

  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  let query = supabaseAdmin
    .from("transactions")
    .select("*", { count: "exact" })
    .eq("owner_id", profileId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);

  const { data: transactions, error, count } = await query;
  if (error) return c.json({ success: false, error: "Failed to fetch transactions" }, 500);

  // Stats — single aggregate query
  const { data: allTx } = await supabaseAdmin
    .from("transactions")
    .select("status, amount")
    .eq("owner_id", profileId);

  const all = allTx ?? [];
  const stats = {
    total:       all.length,
    processing:  all.filter(t => t.status === "processing").length,
    completed:   all.filter(t => t.status === "completed").length,
    pending:     all.filter(t => t.status === "pending").length,
    failed:      all.filter(t => t.status === "failed").length,
    blocked:     all.filter(t => t.status === "blocked").length,
    cancelled:   all.filter(t => t.status === "cancelled").length,
    totalAmount: all
      .filter(t => t.status === "completed")
      .reduce((s: number, t: any) => s + (Number(t.amount) || 0), 0),
  };

  return c.json({
    success: true,
    transactions: transactions ?? [],
    count: count ?? 0,
    stats,
    pagination: { limit, offset, hasMore: (count ?? 0) > offset + limit },
  });
});

export default app;
