import type { Context, Next } from "hono";
import { paymentMiddleware } from "@x402/hono";
import type { x402ResourceServer } from "@x402/core/server";
import { getTokenConfig } from "../tokenRegistry";
import type { Network } from "@x402/core/types";

interface AcceptEntry {
  scheme: string;
  price: string;
  network: Network;
  payTo: string;
  asset: string;
}

const cache = new Map<string, { accepts: Omit<AcceptEntry, "price">[]; cachedAt: number }>();
const CACHE_TTL = 30_000;

async function getMerchantAccepts(
  supabaseAdmin: any,
  ownerId: string,
  price: string
): Promise<AcceptEntry[] | null> {
  const now = Date.now();
  const hit = cache.get(ownerId);
  if (hit && now - hit.cachedAt < CACHE_TTL) {
    return hit.accepts.map(a => ({ ...a, price }));
  }

  const [{ data: profile }, { data: configs }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("wallet_address, solana_wallet_address, stellar_wallet_address")
      .eq("user_id", ownerId)
      .single(),
    supabaseAdmin
      .from("merchant_payment_configs")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("enabled", true),
  ]);

  if (!configs?.length) return null;

  const accepts: Omit<AcceptEntry, "price">[] = configs
    .map((cfg: any) => {
      const token = getTokenConfig(cfg.chain_id, cfg.token_symbol);
      if (!token) return null;

      let payTo: string | null = null;
      if (token.chainFamily === "evm") payTo = profile?.wallet_address ?? null;
      else if (token.chainFamily === "solana") payTo = profile?.solana_wallet_address ?? null;
      else if (token.chainFamily === "stellar") payTo = profile?.stellar_wallet_address ?? null;

      if (!payTo) return null;

      return { scheme: "exact", network: token.network, payTo, asset: token.asset };
    })
    .filter((a: any): a is Omit<AcceptEntry, "price"> => a !== null);

  if (!accepts.length) return null;
  cache.set(ownerId, { accepts, cachedAt: now });
  return accepts.map(a => ({ ...a, price }));
}

export function invalidateCache(ownerId: string): void {
  cache.delete(ownerId);
}

export function createDynamicPaymentMiddleware(
  path: string,
  price: string,
  resourceServer: x402ResourceServer,
  supabaseAdmin: any
) {
  return async (c: Context, next: Next) => {
    const linkHash = c.req.header("X-Payment-Link") || c.req.header("x-payment-link");
    let ownerId: string | null = null;

    if (linkHash) {
      const { data } = await supabaseAdmin
        .from("payment_links")
        .select("owner_id")
        .eq("payment_link", linkHash)
        .single();
      ownerId = data?.owner_id ?? null;
    }

    if (!ownerId) {
      const { data } = await supabaseAdmin
        .from("profiles")
        .select("user_id")
        .limit(1)
        .single();
      ownerId = data?.user_id ?? null;
    }

    if (!ownerId) return c.json({ error: "Merchant not found" }, 500);

    const accepts = await getMerchantAccepts(supabaseAdmin, ownerId, price);

    if (!accepts?.length) {
      return next();
    }

    const dynamicMiddleware = paymentMiddleware(
      { [path]: { accepts, description: "Payment", mimeType: "application/json" } },
      resourceServer
    );
    return dynamicMiddleware(c, next);
  };
}
