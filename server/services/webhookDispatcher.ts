import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MAX_ATTEMPTS = 5;

// ─── Payload type ─────────────────────────────────────────────────────────────

export interface ZapPayWebhookPayload {
  event: 'transaction.confirmed';
  transaction_id: string;
  tx_hash: string;
  network: string;
  amount: number;
  currency: string;
  crypto_amount: number | null;
  crypto_currency: string | null;
  wallet_address: string | null;
  payment_link_id: string | null;
  payment_link_hash: string | null;
  owner_id: string;
  session_id: string | null;
  confirmed_at: string;
}

// ─── HMAC signing ─────────────────────────────────────────────────────────────

function buildSignedHeaders(
  rawBody: string,
  secret: string,
): { 'X-ZapPay-Signature': string; 'X-ZapPay-Timestamp': string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  return {
    'X-ZapPay-Signature': `sha256=${sig}`,
    'X-ZapPay-Timestamp': ts,
  };
}

// ─── Full transaction fetch (with payment_link hash via JOIN) ─────────────────

interface FullTransaction {
  id: string;
  owner_id: string;
  payment_link_id: string | null;
  amount: number;
  currency: string;
  crypto_amount: number | null;
  crypto_currency: string | null;
  tx_hash: string;
  network: string;
  wallet_address: string | null;
  session_id: string | null;
  payment_link_hash: string | null;
}

async function fetchFullTransaction(transactionId: string): Promise<FullTransaction | null> {
  // First fetch the transaction row
  const { data: tx, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('id, owner_id, payment_link_id, amount, currency, crypto_amount, crypto_currency, tx_hash, network, wallet_address, session_id')
    .eq('id', transactionId)
    .single();

  if (txError || !tx) {
    console.error(`[WebhookDispatcher] Failed to fetch transaction ${transactionId}:`, txError?.message);
    return null;
  }

  // Fetch payment_link hash if there's a payment_link_id
  let payment_link_hash: string | null = null;
  if (tx.payment_link_id) {
    const { data: link } = await supabaseAdmin
      .from('payment_links')
      .select('payment_link')
      .eq('id', tx.payment_link_id)
      .single();
    payment_link_hash = link?.payment_link ?? null;
  }

  return { ...tx, payment_link_hash };
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

async function markDelivered(transactionId: string): Promise<void> {
  await supabaseAdmin
    .from('transactions')
    .update({ webhook_delivered_at: new Date().toISOString() })
    .eq('id', transactionId);
}

async function incrementAttempt(transactionId: string, errorMsg: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('webhook_attempts')
    .eq('id', transactionId)
    .single();

  await supabaseAdmin
    .from('transactions')
    .update({
      webhook_attempts: (data?.webhook_attempts ?? 0) + 1,
      webhook_last_error: errorMsg.slice(0, 500),
    })
    .eq('id', transactionId);
}

// ─── Single delivery attempt ──────────────────────────────────────────────────

async function deliverOnce(tx: FullTransaction): Promise<{ ok: boolean; retryable: boolean; error?: string }> {
  const secret = process.env.LAVO_WEBHOOK_SECRET;
  const webhookUrl = process.env.LAVO_WEBHOOK_URL;

  if (!secret || !webhookUrl) {
    return { ok: false, retryable: false, error: 'LAVO_WEBHOOK_URL or LAVO_WEBHOOK_SECRET not configured' };
  }

  // No payment_link_hash means this is a direct/session payment — not linked to Lavo
  if (!tx.payment_link_hash) {
    console.log(`[WebhookDispatcher] Skipping ${tx.id}: no payment_link_hash`);
    await markDelivered(tx.id);
    return { ok: true, retryable: false };
  }

  const payload: ZapPayWebhookPayload = {
    event: 'transaction.confirmed',
    transaction_id: tx.id,
    tx_hash: tx.tx_hash,
    network: tx.network,
    amount: tx.amount,
    currency: tx.currency,
    crypto_amount: tx.crypto_amount,
    crypto_currency: tx.crypto_currency,
    wallet_address: tx.wallet_address,
    payment_link_id: tx.payment_link_id,
    payment_link_hash: tx.payment_link_hash,
    owner_id: tx.owner_id,
    session_id: tx.session_id,
    confirmed_at: new Date().toISOString(),
  };

  const rawBody = JSON.stringify(payload);
  const headers = buildSignedHeaders(rawBody, secret);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: rawBody,
    });

    if (response.ok) return { ok: true, retryable: false };

    const text = await response.text().catch(() => '');
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500 || response.status === 404;
    return { ok: false, retryable, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  } catch (err: any) {
    return { ok: false, retryable: true, error: err.message };
  }
}

// ─── Public: dispatch webhook for one transaction ─────────────────────────────

export async function dispatchWebhook(transactionId: string): Promise<void> {
  const tx = await fetchFullTransaction(transactionId);
  if (!tx) return;

  const result = await deliverOnce(tx);

  if (result.ok) {
    await markDelivered(transactionId);
    console.log(`[WebhookDispatcher] Delivered webhook for ${transactionId}`);
  } else if (result.retryable) {
    await incrementAttempt(transactionId, result.error ?? 'unknown');
    console.warn(`[WebhookDispatcher] Delivery failed (will retry) for ${transactionId}: ${result.error}`);
  } else {
    await supabaseAdmin
      .from('transactions')
      .update({ webhook_attempts: MAX_ATTEMPTS, webhook_last_error: result.error })
      .eq('id', transactionId);
    console.error(`[WebhookDispatcher] Permanent delivery failure for ${transactionId}: ${result.error}`);
  }
}

// ─── Public: retry sweep (called every poller tick) ───────────────────────────

export async function retryPendingWebhooks(): Promise<void> {
  const { data: rows, error } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('status', 'completed')
    .is('webhook_delivered_at', null)
    .lt('webhook_attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(20);

  if (error || !rows?.length) return;

  for (const row of rows) {
    await dispatchWebhook(row.id);
  }
}
