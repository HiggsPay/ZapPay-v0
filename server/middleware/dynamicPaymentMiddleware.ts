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
  price: string,
  supportedNetworks: Set<string>
): Promise<AcceptEntry[] | null> {
  const now = Date.now();
  const hit = cache.get(ownerId);
  if (hit && now - hit.cachedAt < CACHE_TTL) {
    return hit.accepts
      .filter(a => supportedNetworks.size === 0 || supportedNetworks.has(a.network as string))
      .map(a => ({ ...a, price }));
  }

  const [{ data: profile }, { data: configs }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("wallet_address, solana_wallet_address, stellar_wallet_address")
      .eq("id", ownerId)
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

  const filtered = accepts.filter(
    a => supportedNetworks.size === 0 || supportedNetworks.has(a.network as string)
  );
  if (!filtered.length) return null;
  return filtered.map(a => ({ ...a, price }));
}

export function invalidateCache(ownerId: string): void {
  cache.delete(ownerId);
}

export function createCheckoutPaymentMiddleware(
  resourceServer: x402ResourceServer,
  supabaseAdmin: any,
  supportedNetworks: Set<string>
) {
  return async (c: Context, next: Next) => {
    const checkoutId = c.req.header("X-Checkout-Id");
    if (!checkoutId) return c.json({ error: "X-Checkout-Id header required" }, 400);

    const { data: checkout } = await supabaseAdmin
      .from("checkouts")
      .select("owner_id, total_amount, currency, status, expires_at")
      .eq("id", checkoutId)
      .single();

    if (!checkout) return c.json({ error: "Checkout not found" }, 404);
    if (checkout.status !== "pending") return c.json({ error: "Checkout already paid or expired" }, 409);
    if (new Date() > new Date(checkout.expires_at)) {
      await supabaseAdmin.from("checkouts").update({ status: "expired" }).eq("id", checkoutId);
      return c.json({ error: "Checkout expired" }, 410);
    }

    const price = `$${Number(checkout.total_amount).toFixed(2)}`;
    const accepts = await getMerchantAccepts(supabaseAdmin, checkout.owner_id, price, supportedNetworks);
    if (!accepts?.length) return c.json({ error: "Merchant payment config not found" }, 500);

    const dynamicMiddleware = paymentMiddleware(
      { "/api/checkout/pay": { accepts, description: "Cart checkout", mimeType: "application/json" } },
      resourceServer
    );
    return dynamicMiddleware(c, next);
  };
}

export function createDynamicPaymentMiddleware(
  path: string,
  price: string,
  resourceServer: x402ResourceServer,
  supabaseAdmin: any,
  supportedNetworks: Set<string>
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
        .select("id")
        .limit(1)
        .single();
      ownerId = data?.id ?? null;
    }

    if (!ownerId) return c.json({ error: "Merchant not found" }, 500);

    const accepts = await getMerchantAccepts(supabaseAdmin, ownerId, price, supportedNetworks);

    if (!accepts?.length) {
      return c.json({
        error: "Merchant has not configured any payment methods. Please set up accepted chains and tokens in Settings.",
        code: "MERCHANT_PAYMENT_CONFIG_MISSING",
      }, 402);
    }

    const dynamicMiddleware = paymentMiddleware(
      { [path]: { accepts, description: "Payment", mimeType: "application/json" } },
      resourceServer
    );
    return dynamicMiddleware(c, next);
  };
}
