import { Hono } from "hono";
import { createHash } from "crypto";
import { clerkAuthMiddleware, getMerchant } from "../middleware/clerkAuth";
import { supabaseAdmin } from "../lib/supabase";

const app = new Hono();

// Public route first — no auth needed for consumer to load a payment link
app.get("/api/payment-link/:paymentLink", async (c) => {
  const paymentLink = c.req.param("paymentLink");
  const { data, error } = await supabaseAdmin
    .from("payment_links")
    .select("*")
    .eq("payment_link", paymentLink)
    .single();
  if (error || !data) return c.json({ success: false, error: "Payment link not found" }, 404);

  if (data.expiry_date && new Date() > new Date(data.expiry_date))
    return c.json({ success: false, error: "Payment link has expired" }, 410);

  const { data: product } = await supabaseAdmin
    .from("products")
    .select("name")
    .eq("id", data.product_id)
    .single();

  return c.json({
    success: true,
    payment_link: { ...data, product_name: product?.name ?? data.link_name },
  });
});

// Authenticated routes
app.use("/api/payment-links", clerkAuthMiddleware);
app.use("/api/payment-link", clerkAuthMiddleware);

app.get("/api/payment-links", async (c) => {
  const { profileId } = getMerchant(c);
  const { data, error } = await supabaseAdmin
    .from("payment_links")
    .select("*, products!inner(name)")
    .eq("owner_id", profileId)
    .order("created_at", { ascending: false });
  if (error) return c.json({ success: false, error: "Failed to fetch payment links" }, 500);
  const transformed = (data ?? []).map((link: any) => ({
    ...link,
    product_name: link.products.name,
  }));
  return c.json({ success: true, payment_links: transformed });
});

app.post("/api/payment-link", async (c) => {
  const { profileId } = getMerchant(c);
  const body = await c.req.json();
  const { link_name, product_name, expiry_date } = body;

  if (!link_name || !product_name || !expiry_date)
    return c.json({ success: false, error: "link_name, product_name, and expiry_date are required" }, 400);

  const expiryDate = new Date(expiry_date);
  if (isNaN(expiryDate.getTime()))
    return c.json({ success: false, error: "Invalid expiry_date format" }, 400);
  if (expiryDate <= new Date())
    return c.json({ success: false, error: "expiry_date must be in the future" }, 400);

  const { data: products, error: productError } = await supabaseAdmin
    .from("products")
    .select("id, name, pricing")
    .eq("name", product_name)
    .eq("owner_id", profileId)
    .limit(1);

  if (productError || !products?.length)
    return c.json({ success: false, error: `Product '${product_name}' not found` }, 404);

  const product = products[0];
  const hash = createHash("md5")
    .update(product.id + Date.now().toString() + Math.random().toString())
    .digest("hex");
  const paymentLinkHash = "pay_" + hash.substring(0, 16);

  const { data, error } = await supabaseAdmin
    .from("payment_links")
    .insert([{
      owner_id: profileId,
      link_name,
      payment_link: paymentLinkHash,
      product_id: product.id,
      pricing: product.pricing,
      expiry_date: expiryDate.toISOString(),
    }])
    .select()
    .single();

  if (error) return c.json({ success: false, error: "Failed to create payment link" }, 500);
  return c.json({ success: true, payment_link: data }, 201);
});

export default app;
