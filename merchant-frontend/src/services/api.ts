import axios from "axios";
import type { AxiosInstance } from "axios";
import type { WalletClient } from "viem";
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

// Adapt a viem WalletClient (MetaMask-backed) into the ClientEvmSigner interface
// expected by @x402/evm. The v2 client calls signer.signTypedData({ domain, types,
// primaryType, message }) and reads signer.address directly (no nested account).
function toX402Signer(walletClient: WalletClient) {
  const address = walletClient.account?.address;
  if (!address) throw new Error("WalletClient has no account");
  return {
    address,
    signTypedData: (msg: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) =>
      walletClient.signTypedData({
        account: walletClient.account!,
        domain: msg.domain as any,
        types: msg.types as any,
        primaryType: msg.primaryType,
        message: msg.message as any,
      }),
  };
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

// Clerk token getter — injected from outside (set by the component that has Clerk context)
let _getClerkToken: (() => Promise<string | null>) | null = null;

export function setClerkTokenGetter(fn: () => Promise<string | null>) {
  _getClerkToken = fn;
}

// Base axios instance without payment interceptor
const baseApiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
});

// Attach Clerk JWT on every request
baseApiClient.interceptors.request.use(async (config) => {
  if (_getClerkToken) {
    const token = await _getClerkToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// This will be dynamically set based on wallet connection
let apiClient: AxiosInstance = baseApiClient;

// Update the API client with a wallet
export function updateApiClient(walletClient: WalletClient | null) {
  if (walletClient && walletClient.account) {
    // Build an x402 v2 client and register the EVM "exact" scheme across any
    // EVM network (eip155:*). The signer adapter bridges viem's WalletClient
    // to the ClientEvmSigner shape expected by @x402/evm.
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: toX402Signer(walletClient) });
    apiClient = wrapAxiosWithPayment(baseApiClient, client);
    console.log("💳 API client updated with wallet:", walletClient.account.address);
  } else {
    // No wallet connected - reset to base client
    apiClient = baseApiClient;
    console.log("⚠️ API client reset - no wallet connected");
  }
}

// API endpoints
export const api = {
  // Free endpoints
  getHealth: async () => {
    const response = await apiClient.get("/api/health");
    return response.data;
  },

  getPaymentOptions: async () => {
    const response = await apiClient.get("/api/payment-options");
    return response.data;
  },

  validateSession: async (sessionId: string) => {
    const response = await apiClient.get(`/api/session/${sessionId}`);
    return response.data;
  },

  getActiveSessions: async () => {
    const response = await apiClient.get("/api/sessions");
    return response.data;
  },

  // Paid endpoints
  purchase24HourSession: async () => {
    console.log("🔐 Purchasing 24-hour session access...");
    const response = await apiClient.post("/api/pay/session");
    console.log("✅ 24-hour session created:", response.data);
    return response.data;
  },

  purchaseOneTimeAccess: async () => {
    console.log("⚡ Purchasing one-time access...");
    const response = await apiClient.post("/api/pay/onetime");
    console.log("✅ One-time access granted:", response.data);
    return response.data;
  },

  // Product management
  createProduct: async (productData: { name: string; pricing: number }) => {
    console.log("📦 Creating new product...", productData);
    const response = await apiClient.post("/api/product", productData);
    console.log("✅ Product created:", response.data);
    return response.data;
  },

  getProducts: async () => {
    console.log("📦 Fetching products...");
    const response = await apiClient.get("/api/products");
    console.log("✅ Products fetched:", response.data);
    return response.data;
  },

  // Payment Links management
  getPaymentLinks: async () => {
    console.log("🔗 Fetching payment links...");
    const response = await apiClient.get("/api/payment-links");
    console.log("✅ Payment links fetched:", response.data);
    return response.data;
  },

  createPaymentLink: async (paymentLinkData: { link_name: string; product_name: string; expiry_date: string }) => {
    console.log("🔗 Creating payment link...", paymentLinkData);
    const response = await apiClient.post("/api/payment-link", paymentLinkData);
    console.log("✅ Payment link created:", response.data);
    return response.data;
  },

  // Transaction management
  getTransactions: async (params?: { status?: string; limit?: number; offset?: number }) => {
    console.log("💳 Fetching transactions...", params);
    const queryParams = new URLSearchParams();
    if (params?.status) queryParams.append('status', params.status);
    if (params?.limit) queryParams.append('limit', params.limit.toString());
    if (params?.offset) queryParams.append('offset', params.offset.toString());

    const response = await apiClient.get(`/api/transactions?${queryParams.toString()}`);
    console.log("✅ Transactions fetched:", response.data);
    return response.data;
  },

  getWalletRiskAnalysis: async (address: string) => {
    console.log("🔍 Fetching wallet risk analysis...", address);
    const response = await apiClient.get(`/api/risk/wallet/${address}`);
    console.log("✅ Risk analysis fetched:", response.data);
    return response.data;
  },

  // Payment config
  getSupportedTokens: async (): Promise<{ supported: TokenConfig[] }> => {
    const res = await apiClient.get("/api/payment-config/supported");
    return res.data;
  },

  getPaymentConfig: async (): Promise<{ success: boolean; configs: MerchantPaymentConfig[] }> => {
    const res = await apiClient.get("/api/payment-config");
    return res.data;
  },

  updatePaymentConfig: async (configs: Array<{ chain_id: string; token_symbol: string }>) => {
    const res = await apiClient.put("/api/payment-config", { configs });
    return res.data;
  },

  getProfile: async (): Promise<{ success: boolean; profile: MerchantProfile }> => {
    const res = await apiClient.get("/api/profile");
    return res.data;
  },

  updateWalletAddress: async (wallet_address: string) => {
    const res = await apiClient.put("/api/profile/wallet", { wallet_address });
    return res.data;
  },

  updateSolanaWalletAddress: async (solana_wallet_address: string) => {
    const res = await apiClient.put("/api/profile/solana-wallet", { solana_wallet_address });
    return res.data;
  },

  updateStellarWalletAddress: async (stellar_wallet_address: string) => {
    const res = await apiClient.put("/api/profile/stellar-wallet", { stellar_wallet_address });
    return res.data;
  },

  updateWebhookUrl: async (webhook_url: string | null) => {
    const res = await apiClient.put("/api/profile/webhook", { webhook_url });
    return res.data;
  },

  getWebhookSecret: async (): Promise<{ success: boolean; webhook_secret: string | null }> => {
    const res = await apiClient.get("/api/profile/webhook-secret");
    return res.data;
  },

  testWebhook: async (): Promise<{ ok: boolean; status: number; error?: string }> => {
    const res = await apiClient.post("/api/profile/webhook/test");
    return res.data;
  },

  // Checkout sessions (Stripe-style)
  createCheckout: async (body: CreateCheckoutBody): Promise<CreateCheckoutResponse> => {
    const res = await apiClient.post("/api/checkout", body);
    return res.data;
  },

  listCheckouts: async (params?: { status?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.status) q.append("status", params.status);
    if (params?.limit)  q.append("limit",  params.limit.toString());
    if (params?.offset) q.append("offset", params.offset.toString());
    const res = await apiClient.get(`/api/checkouts?${q.toString()}`);
    return res.data;
  },

  getCheckout: async (id: string) => {
    const res = await apiClient.get(`/api/checkout/${id}`);
    return res.data;
  },

  expireCheckout: async (id: string) => {
    const res = await apiClient.post(`/api/checkout/${id}/expire`);
    return res.data;
  },

  // Balance
  getBalance: async (): Promise<GetBalanceResponse> => {
    const res = await apiClient.get("/api/balance");
    return res.data;
  },

  syncBalance: async (body: { currency: string; chain_id: string; amount: number; usd_value?: number }) => {
    const res = await apiClient.post("/api/balance/sync", body);
    return res.data;
  },

  getCheckoutPaymentOptions: async (checkoutId: string): Promise<CheckoutPaymentOptionsResponse> => {
    const res = await baseApiClient.get(`/api/checkout/${checkoutId}/payment-options`);
    return res.data;
  },

  payCheckout: async (checkoutId: string, paymentAxiosInstance: any) => {
    const res = await paymentAxiosInstance.post("/api/checkout/pay", {}, {
      headers: { "X-Checkout-Id": checkoutId },
    });
    return res.data;
  },
};

// Types for API responses
export interface MerchantProfile {
  id: string;
  email: string | null;
  display_name: string | null;
  wallet_address: string | null;
  solana_wallet_address: string | null;
  stellar_wallet_address: string | null;
  api_key: string | null;
  plan: string;
  webhook_url: string | null;
}

export interface TokenConfig {
  chainId: string;
  chainName: string;
  chainFamily: string;
  network: string;
  tokenSymbol: string;
  tokenName: string;
  asset: string;
  decimals: number;
  isTestnet: boolean;
}

export interface MerchantPaymentConfig {
  id: string;
  owner_id: string;
  chain_id: string;
  token_symbol: string;
  asset: string | null;
  enabled: boolean;
}

export interface PaymentOption {
  name: string;
  endpoint: string;
  price: string;
  description: string;
}

export interface Session {
  id: string;
  type: "24hour" | "onetime";
  createdAt: string;
  expiresAt: string;
  validFor?: string;
  remainingTime?: number;
}

export interface SessionValidation {
  valid: boolean;
  error?: string;
  session?: Session;
}

export interface Product {
  id: string;
  name: string;
  pricing: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProductResponse {
  success: boolean;
  message?: string;
  product?: Product;
  error?: string;
}

export interface PaymentLink {
  id: string;
  link_name: string;
  payment_link: string;
  product_id: string;
  product_name: string;
  pricing: number;
  expiry_date: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentLinkResponse {
  success: boolean;
  message?: string;
  payment_link?: PaymentLink;
  error?: string;
}

export interface Transaction {
  id: string;
  owner_id: string;
  payment_link_id?: string;
  type: 'payment' | 'withdrawal' | 'deposit';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  amount: number;
  currency: string;
  crypto_amount?: number;
  crypto_currency?: string;
  customer_id?: string;
  tx_hash?: string;
  network_fee?: number;
  created_at: string;
  updated_at?: string;
}

export interface TransactionStats {
  total: number;
  processing: number;
  completed: number;
  pending: number;
  failed: number;
  blocked: number;
  cancelled: number;
  totalAmount: number;
}

export interface CheckoutLineItem {
  product_id: string;
  name: string;
  unit_price: number;
  qty: number;
  subtotal: number;
}

export interface CheckoutPaymentOption {
  chain_id: string;
  chain_name: string;
  chain_family: "evm" | "solana" | "stellar";
  network: string;
  token_symbol: string;
  token_name: string;
  asset: string;
  is_testnet: boolean;
  pay_to: string;
}

export interface CheckoutPaymentOptionsResponse {
  success: boolean;
  checkout: {
    id: string;
    total: number;
    currency: string;
    line_items: CheckoutLineItem[];
    expires_at: string;
    status: string;
  };
  merchant: { display_name: string };
  payment_options: CheckoutPaymentOption[];
}

export interface CreateCheckoutBody {
  items: Array<{ product_id: string; qty?: number }>;
  success_url?: string;
  cancel_url?: string;
  metadata?: Record<string, unknown>;
  currency?: string;
  expires_in_minutes?: number;
}

export interface CreateCheckoutResponse {
  success: boolean;
  checkout_id: string;
  checkout_url: string;
  total: number;
  currency: string;
  line_items: CheckoutLineItem[];
  expires_at: string;
  status: string;
  error?: string;
}

export interface BalanceRow {
  id: string;
  owner_id: string;
  currency: string;
  chain_id: string;
  amount: number;
  usd_value: number | null;
  updated_at: string;
}

export interface GetBalanceResponse {
  success: boolean;
  balances: BalanceRow[];
  total_usd: number;
  error?: string;
}

export interface Checkout {
  id: string;
  owner_id: string;
  status: 'pending' | 'paid' | 'expired' | 'cancelled';
  total_amount: number;
  currency: string;
  line_items: CheckoutLineItem[];
  success_url?: string;
  cancel_url?: string;
  metadata?: Record<string, unknown>;
  expires_at: string;
  paid_at?: string;
  created_at: string;
}

export interface GetTransactionsResponse {
  success: boolean;
  transactions: Transaction[];
  count: number;
  stats: TransactionStats;
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  error?: string;
} 