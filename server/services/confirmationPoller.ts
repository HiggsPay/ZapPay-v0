import { createPublicClient, http } from 'viem';
import { mainnet, base, polygon, arbitrum, optimism, bsc } from 'viem/chains';
import type { PublicClient, Chain } from 'viem';
import { Connection, clusterApiUrl } from '@solana/web3.js';
import { Horizon } from '@stellar/stellar-sdk';
import { getPendingTransactions, updateTransactionStatus } from './transactionService.js';
import { dispatchWebhook, retryPendingWebhooks } from './webhookDispatcher.js';

const STALE_AFTER_MS = parseInt(process.env.TX_STALE_AFTER_MS ?? String(30 * 60 * 1000));

// ─── EVM ────────────────────────────────────────────────────────────────────

const EVM_CHAIN_CONFIG: Record<string, { chain: Chain; rpcEnvVar: string }> = {
  'eip155:1':    { chain: mainnet,   rpcEnvVar: 'RPC_URL_ETHEREUM' },
  'eip155:8453': { chain: base,      rpcEnvVar: 'RPC_URL_BASE' },
  'eip155:137':  { chain: polygon,   rpcEnvVar: 'RPC_URL_POLYGON' },
  'eip155:42161':{ chain: arbitrum,  rpcEnvVar: 'RPC_URL_ARBITRUM' },
  'eip155:10':   { chain: optimism,  rpcEnvVar: 'RPC_URL_OPTIMISM' },
  'eip155:56':   { chain: bsc,       rpcEnvVar: 'RPC_URL_BSC' },
};

const evmClientCache: Record<string, PublicClient> = {};

function getEvmClient(network: string): PublicClient | null {
  if (evmClientCache[network]) return evmClientCache[network];

  const config = EVM_CHAIN_CONFIG[network];
  if (!config) return null;

  const rpcUrl = process.env[config.rpcEnvVar];
  if (!rpcUrl) {
    console.warn(`⚠️ confirmationPoller: ${config.rpcEnvVar} not set, using public RPC for ${network} (may be rate-limited)`);
  }

  const client = createPublicClient({
    chain: config.chain,
    transport: rpcUrl ? http(rpcUrl) : http(),
  }) as PublicClient;

  evmClientCache[network] = client;
  return client;
}

async function checkEvm(tx: { id: string; tx_hash: string; network: string }, ageMs: number): Promise<void> {
  const client = getEvmClient(tx.network);
  if (!client) {
    console.warn(`⚠️ confirmationPoller: unsupported EVM network ${tx.network}, skipping`);
    return;
  }

  try {
    const receipt = await client.getTransactionReceipt({ hash: tx.tx_hash as `0x${string}` });
    if (receipt.status === 'success') {
      await updateTransactionStatus(tx.id, 'completed');
      console.log(`✅ ${tx.id} [EVM]: confirmed (block ${receipt.blockNumber})`);
      dispatchWebhook(tx.id).catch(err =>
        console.error(`[WebhookDispatcher] EVM dispatch error for ${tx.id}:`, err.message)
      );
    } else if (receipt.status === 'reverted') {
      await updateTransactionStatus(tx.id, 'failed');
      console.log(`❌ ${tx.id} [EVM]: reverted on-chain`);
    }
  } catch (err: any) {
    const notFound =
      err?.name === 'TransactionReceiptNotFoundError' ||
      err?.message?.includes('could not be found');
    if (notFound && ageMs > STALE_AFTER_MS) {
      await updateTransactionStatus(tx.id, 'failed');
      console.warn(`⏰ ${tx.id} [EVM]: stale after ${Math.round(ageMs / 60000)}min → failed`);
    } else if (!notFound) {
      console.error(`⚠️ RPC error for ${tx.id} [EVM]: ${err.message} — skipping this cycle`);
    }
  }
}

// ─── Solana ─────────────────────────────────────────────────────────────────

const solanaClientCache: Record<string, Connection> = {};

function getSolanaConnection(network: string): Connection {
  if (solanaClientCache[network]) return solanaClientCache[network];

  let endpoint: string;
  if (network === 'solana:mainnet') {
    endpoint = process.env.RPC_URL_SOLANA ?? clusterApiUrl('mainnet-beta');
  } else {
    // solana:devnet or any other solana network
    endpoint = process.env.RPC_URL_SOLANA_DEVNET ?? clusterApiUrl('devnet');
  }

  if (!process.env.RPC_URL_SOLANA && network === 'solana:mainnet') {
    console.warn(`⚠️ confirmationPoller: RPC_URL_SOLANA not set, using public Solana RPC (rate-limited)`);
  }

  const conn = new Connection(endpoint, 'confirmed');
  solanaClientCache[network] = conn;
  return conn;
}

async function checkSolana(tx: { id: string; tx_hash: string; network: string }, ageMs: number): Promise<void> {
  const conn = getSolanaConnection(tx.network);

  try {
    const result = await conn.getTransaction(tx.tx_hash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (result === null) {
      // Not yet confirmed
      if (ageMs > STALE_AFTER_MS) {
        await updateTransactionStatus(tx.id, 'failed');
        console.warn(`⏰ ${tx.id} [Solana]: stale after ${Math.round(ageMs / 60000)}min → failed`);
      }
      return;
    }

    if (result.meta?.err === null) {
      await updateTransactionStatus(tx.id, 'completed');
      console.log(`✅ ${tx.id} [Solana]: confirmed (slot ${result.slot})`);
      dispatchWebhook(tx.id).catch(err =>
        console.error(`[WebhookDispatcher] Solana dispatch error for ${tx.id}:`, err.message)
      );
    } else {
      await updateTransactionStatus(tx.id, 'failed');
      console.log(`❌ ${tx.id} [Solana]: failed on-chain — ${JSON.stringify(result.meta?.err)}`);
    }
  } catch (err: any) {
    console.error(`⚠️ RPC error for ${tx.id} [Solana]: ${err.message} — skipping this cycle`);
  }
}

// ─── Stellar ─────────────────────────────────────────────────────────────────

const stellarServerCache: Record<string, Horizon.Server> = {};

function getStellarServer(network: string): Horizon.Server {
  if (stellarServerCache[network]) return stellarServerCache[network];

  let horizonUrl: string;
  if (network === 'stellar:mainnet') {
    horizonUrl = process.env.RPC_URL_STELLAR ?? 'https://horizon.stellar.org';
  } else {
    horizonUrl = process.env.RPC_URL_STELLAR_TESTNET ?? 'https://horizon-testnet.stellar.org';
  }

  if (!process.env.RPC_URL_STELLAR && network === 'stellar:mainnet') {
    console.warn(`⚠️ confirmationPoller: RPC_URL_STELLAR not set, using public Horizon (rate-limited)`);
  }

  const server = new Horizon.Server(horizonUrl);
  stellarServerCache[network] = server;
  return server;
}

async function checkStellar(tx: { id: string; tx_hash: string; network: string }, ageMs: number): Promise<void> {
  const server = getStellarServer(tx.network);

  try {
    const result = await server.transactions().transaction(tx.tx_hash).call();

    if (result.successful) {
      await updateTransactionStatus(tx.id, 'completed');
      console.log(`✅ ${tx.id} [Stellar]: confirmed (ledger ${result.ledger})`);
      dispatchWebhook(tx.id).catch(err =>
        console.error(`[WebhookDispatcher] Stellar dispatch error for ${tx.id}:`, err.message)
      );
    } else {
      await updateTransactionStatus(tx.id, 'failed');
      console.log(`❌ ${tx.id} [Stellar]: failed on-chain`);
    }
  } catch (err: any) {
    const notFound = err?.response?.status === 404;
    if (notFound && ageMs > STALE_AFTER_MS) {
      await updateTransactionStatus(tx.id, 'failed');
      console.warn(`⏰ ${tx.id} [Stellar]: stale after ${Math.round(ageMs / 60000)}min → failed`);
    } else if (!notFound) {
      console.error(`⚠️ Horizon error for ${tx.id} [Stellar]: ${err.message} — skipping this cycle`);
    }
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

async function checkTransaction(tx: { id: string; tx_hash: string; network: string; created_at: string }): Promise<void> {
  const ageMs = Date.now() - new Date(tx.created_at).getTime();

  if (tx.network.startsWith('eip155:')) {
    await checkEvm(tx, ageMs);
  } else if (tx.network.startsWith('solana:')) {
    await checkSolana(tx, ageMs);
  } else if (tx.network.startsWith('stellar:')) {
    await checkStellar(tx, ageMs);
  } else {
    console.warn(`⚠️ confirmationPoller: unknown network prefix ${tx.network}, skipping`);
  }
}

let inFlight = false;

async function pollOnce(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const pending = await getPendingTransactions(50);
    if (pending.length > 0) {
      console.log(`🔍 confirmationPoller: checking ${pending.length} transaction(s)`);
      await Promise.allSettled(pending.map(tx => checkTransaction(tx)));
    }
    await retryPendingWebhooks();
  } finally {
    inFlight = false;
  }
}

export function startConfirmationPoller(intervalMs = 15_000): () => void {
  console.log(`🚀 confirmationPoller started (interval: ${intervalMs}ms, stale threshold: ${STALE_AFTER_MS}ms)`);
  pollOnce().catch(err => console.error('confirmationPoller startup error:', err));
  const handle = setInterval(
    () => pollOnce().catch(err => console.error('confirmationPoller tick error:', err)),
    intervalMs
  );
  return () => clearInterval(handle);
}
