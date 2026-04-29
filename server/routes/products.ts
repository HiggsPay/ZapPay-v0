import { Hono } from "hono";
import { clerkAuthMiddleware, getMerchant } from "../middleware/clerkAuth";
import { supabaseAdmin } from "../lib/supabase";

const app = new Hono();

app.use("/api/product*", clerkAuthMiddleware);
app.use("/api/products", clerkAuthMiddleware);

app.get("/api/products", async (c) => {
  const { profileId } = getMerchant(c);
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .eq("owner_id", profileId)
    .order("created_at", { ascending: false });
  if (error) return c.json({ success: false, error: "Failed to fetch products" }, 500);
  return c.json({ success: true, products: data ?? [] });
});

app.post("/api/product", async (c) => {
  const { profileId } = getMerchant(c);
  const body = await c.req.json();
  const { name, pricing, description, currency, image_url } = body;
  if (!name || typeof pricing !== "number")
    return c.json({ success: false, error: "name and pricing (number) are required" }, 400);

  const { data, error } = await supabaseAdmin
    .from("products")
    .insert([{
      owner_id: profileId,
      name,
      pricing,
      description: description ?? null,
      currency: currency ?? "USD",
      image_url: image_url ?? null,
    }])
    .select()
    .single();

  if (error) return c.json({ success: false, error: "Failed to create product" }, 500);
  return c.json({ success: true, product: data }, 201);
});

app.put("/api/product/:id", async (c) => {
  const { profileId } = getMerchant(c);
  const productId = c.req.param("id");
  const body = await c.req.json();
  const { name, pricing, description, currency, active, image_url } = body;

  // Verify ownership before update
  const { data: existing } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("id", productId)
    .eq("owner_id", profileId)
    .single();
  if (!existing) return c.json({ success: false, error: "Product not found" }, 404);

  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = name;
  if (pricing !== undefined) patch.pricing = pricing;
  if (description !== undefined) patch.description = description;
  if (currency !== undefined) patch.currency = currency;
  if (active !== undefined) patch.active = active;
  if (image_url !== undefined) patch.image_url = image_url;

  const { data, error } = await supabaseAdmin
    .from("products")
    .update(patch)
    .eq("id", productId)
    .eq("owner_id", profileId)
    .select()
    .single();
  if (error) return c.json({ success: false, error: "Failed to update product" }, 500);
  return c.json({ success: true, product: data });
});

app.delete("/api/product/:id", async (c) => {
  const { profileId } = getMerchant(c);
  const productId = c.req.param("id");
  const { error } = await supabaseAdmin
    .from("products")
    .delete()
    .eq("id", productId)
    .eq("owner_id", profileId);
  if (error) return c.json({ success: false, error: "Failed to delete product" }, 500);
  return c.json({ success: true });
});

export default app;
