import type { Context, Next } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import type { MerchantContext } from "./clerkAuth";

// Resolves X-API-Key: zp_live_... → merchant context.
// Sets the same "merchant" variable shape as clerkAuthMiddleware so
// getMerchant(c) works identically downstream.
export async function apiKeyAuthMiddleware(c: Context, next: Next) {
  const key = c.req.header("X-API-Key");
  if (!key?.startsWith("zp_live_")) {
    return c.json({ error: "Invalid or missing X-API-Key" }, 401);
  }

  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id, plan")
    .eq("api_key", key)
    .single();

  if (error || !profile) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("merchant", {
    profileId: profile.id,
    clerkUserId: "",
    plan: profile.plan,
  } as MerchantContext);

  return next();
}

// Accepts either a Clerk JWT (Authorization: Bearer <jwt>) or an API key
// (X-API-Key: zp_live_...). Tries API key first when the header is present.
export async function clerkOrApiKeyMiddleware(c: Context, next: Next) {
  const apiKey = c.req.header("X-API-Key");
  if (apiKey) return apiKeyAuthMiddleware(c, next);

  // Fall through to Clerk
  const { clerkAuthMiddleware } = await import("./clerkAuth");
  return clerkAuthMiddleware(c, next);
}
