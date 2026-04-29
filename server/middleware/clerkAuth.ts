import type { Context, Next } from "hono";
import { verifyToken } from "@clerk/backend";
import { clerkClient } from "../lib/clerk";
import { supabaseAdmin } from "../lib/supabase";

export type MerchantContext = {
  profileId: string;    // profiles.id UUID — used as owner_id in all queries
  clerkUserId: string;  // raw Clerk user ID (user_xxx)
  plan: string;
};

export async function clerkAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);

  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    const clerkUserId = payload.sub;

    // Look up existing profile
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id, clerk_user_id, plan")
      .eq("clerk_user_id", clerkUserId)
      .single();

    if (profile) {
      c.set("merchant", {
        profileId: profile.id,
        clerkUserId,
        plan: profile.plan,
      } as MerchantContext);
      return next();
    }

    // Auto-provision profile on first login
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const email = clerkUser.emailAddresses[0]?.emailAddress ?? null;
    const displayName =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() ||
      email?.split("@")[0] ||
      "Merchant";

    const { data: newProfile, error: insertError } = await supabaseAdmin
      .from("profiles")
      .insert({ clerk_user_id: clerkUserId, email, display_name: displayName })
      .select("id, plan")
      .single();

    if (insertError || !newProfile) {
      console.error("❌ Failed to provision profile:", insertError?.message);
      return c.json({ error: "Failed to provision account" }, 500);
    }

    c.set("merchant", {
      profileId: newProfile.id,
      clerkUserId,
      plan: newProfile.plan,
    } as MerchantContext);
    return next();
  } catch (err: any) {
    console.error("❌ Clerk token verification failed:", err.message);
    return c.json({ error: "Invalid token" }, 401);
  }
}

// Call this inside route handlers after clerkAuthMiddleware has run
export function getMerchant(c: Context): MerchantContext {
  const merchant = c.get("merchant") as MerchantContext | undefined;
  if (!merchant) throw new Error("getMerchant called outside clerkAuthMiddleware");
  return merchant;
}
