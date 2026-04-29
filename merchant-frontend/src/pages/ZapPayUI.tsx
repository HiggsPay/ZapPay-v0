import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Wallet,
  CreditCard,
  Shield,
  CheckCircle,
  AlertCircle,
  ShoppingCart,
  Clock,
} from 'lucide-react';
import axios from "axios";
import type { AxiosInstance } from "axios";
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { requestAccess, getAddress, signTransaction as freighterSignTx } from "@stellar/freighter-api";
import { useWallet } from '@/contexts/WalletContext';
import { api } from '@/services/api';
import type { CheckoutPaymentOption, CheckoutLineItem } from '@/services/api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

const baseApiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
});

// ── Signer adapters ────────────────────────────────────────────────────────────

function toEvmSigner(walletClient: any) {
  return {
    address: walletClient.account.address as `0x${string}`,
    signTypedData: (msg: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) =>
      walletClient.signTypedData({
        account: walletClient.account,
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      }),
  };
}

function toSvmSigner(phantom: any) {
  return {
    publicKey: phantom.publicKey.toString(),
    signTransaction: (tx: any) => phantom.signTransaction(tx),
  };
}

function toStellarSigner(address: string) {
  return {
    publicKey: address,
    signTransaction: async (xdr: string, opts?: { network?: string; networkPassphrase?: string }) => {
      const result = await freighterSignTx({ xdr, ...(opts ?? {}) });
      if ('error' in result) throw new Error(result.error);
      return (result as any).signedTxXdr ?? (result as any).signedTransaction;
    },
  };
}

function buildPaymentClient(
  option: CheckoutPaymentOption,
  evmWalletClient: any,
  svmPhantom: any,
  stellarAddress: string | null
): AxiosInstance | null {
  try {
    if (option.chain_family === 'evm' && evmWalletClient?.account) {
      const client = new x402Client();
      registerExactEvmScheme(client, { signer: toEvmSigner(evmWalletClient) });
      return wrapAxiosWithPayment(baseApiClient, client);
    }
    if (option.chain_family === 'solana' && svmPhantom) {
      const client = new x402Client();
      registerExactSvmScheme(client, { signer: toSvmSigner(svmPhantom) });
      return wrapAxiosWithPayment(baseApiClient, client);
    }
    if (option.chain_family === 'stellar' && stellarAddress) {
      const client = new x402Client();
      client.register("stellar:*", new ExactStellarScheme(toStellarSigner(stellarAddress)));
      return wrapAxiosWithPayment(baseApiClient, client);
    }
  } catch (err) {
    console.error('❌ Failed to build payment client:', err);
  }
  return null;
}

// ── Chain family helpers ───────────────────────────────────────────────────────

const FAMILY_COLORS: Record<string, string> = {
  evm: 'border-orange-400 bg-orange-50',
  solana: 'border-purple-400 bg-purple-50',
  stellar: 'border-blue-400 bg-blue-50',
};

const FAMILY_BADGE: Record<string, string> = {
  evm: 'bg-orange-100 text-orange-700',
  solana: 'bg-purple-100 text-purple-700',
  stellar: 'bg-blue-100 text-blue-700',
};

function walletLabel(family: string): string {
  if (family === 'solana') return 'Phantom';
  if (family === 'stellar') return 'Freighter';
  return 'MetaMask';
}

// ── Payment link interface (legacy mode) ───────────────────────────────────────

interface PaymentLink {
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

const legacyApi = {
  getPaymentLink: async (paymentLink: string) => {
    const response = await baseApiClient.get(`/api/payment-link/${paymentLink}`);
    return response.data;
  },
  getWalletRiskAnalysis: async (walletAddress: string) => {
    const response = await baseApiClient.get(`/api/risk/wallet/${walletAddress}`);
    return response.data;
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ZapPayUI() {
  // paymentLink → /payment/:paymentLink
  // checkoutId  → /c/:checkoutId  OR  ?checkout_id= (legacy)
  const { paymentLink, checkoutId: checkoutIdParam } = useParams<{ paymentLink?: string; checkoutId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const checkoutId = checkoutIdParam ?? searchParams.get('checkout_id');
  const isCartMode = Boolean(checkoutId);

  const { isConnected: isEvmConnected, address: evmAddress, walletClient, error: walletError, isConnecting, connectWallet, disconnectWallet } = useWallet();

  // ── Cart mode state ──────────────────────────────────────────────────────────
  const [checkoutData, setCheckoutData] = useState<{ id: string; total: number; currency: string; line_items: CheckoutLineItem[]; expires_at: string; status: string } | null>(null);
  const [paymentOptions, setPaymentOptions] = useState<CheckoutPaymentOption[]>([]);
  const [selectedOption, setSelectedOption] = useState<CheckoutPaymentOption | null>(null);
  const [isLoadingCheckout, setIsLoadingCheckout] = useState(true);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [expirySecondsLeft, setExpirySecondsLeft] = useState<number | null>(null);

  // Solana (Phantom) local wallet state
  const [svmPhantom, setSvmPhantom] = useState<any>(null);
  const [svmAddress, setSvmAddress] = useState<string | null>(null);

  // Stellar (Freighter) local wallet state
  const [stellarAddress, setStellarAddress] = useState<string | null>(null);

  // Active x402 payment client (rebuilt on selection/wallet change)
  const activeClientRef = useRef<AxiosInstance | null>(null);

  // ── Legacy payment link state ────────────────────────────────────────────────
  const [paymentLinkData, setPaymentLinkData] = useState<PaymentLink | null>(null);
  const [isLoadingPaymentLink, setIsLoadingPaymentLink] = useState(!isCartMode);
  const [paymentLinkError, setPaymentLinkError] = useState<string | null>(null);

  // ── Shared payment state ─────────────────────────────────────────────────────
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'processing' | 'completed'>('pending');
  const [paymentResult, setPaymentResult] = useState<any>(null);

  // ── Load checkout data ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isCartMode || !checkoutId) return;
    setIsLoadingCheckout(true);
    api.getCheckoutPaymentOptions(checkoutId)
      .then(res => {
        if (res.success) {
          setCheckoutData(res.checkout);
          setPaymentOptions(res.payment_options);
          if (res.payment_options.length > 0) setSelectedOption(res.payment_options[0]);
          const secs = Math.floor((new Date(res.checkout.expires_at).getTime() - Date.now()) / 1000);
          setExpirySecondsLeft(Math.max(0, secs));
        } else {
          setCheckoutError('Failed to load checkout');
        }
      })
      .catch(err => setCheckoutError(err.message || 'Failed to load checkout'))
      .finally(() => setIsLoadingCheckout(false));
  }, [checkoutId, isCartMode]);

  // Expiry countdown
  useEffect(() => {
    if (expirySecondsLeft === null || expirySecondsLeft <= 0) return;
    const timer = setInterval(() => setExpirySecondsLeft(s => (s !== null ? Math.max(0, s - 1) : null)), 1000);
    return () => clearInterval(timer);
  }, [expirySecondsLeft]);

  // Rebuild x402 client whenever selection or wallet state changes
  useEffect(() => {
    if (!selectedOption) { activeClientRef.current = null; return; }
    activeClientRef.current = buildPaymentClient(selectedOption, walletClient, svmPhantom, stellarAddress);
  }, [selectedOption, walletClient, svmPhantom, stellarAddress]);

  // ── Load legacy payment link ─────────────────────────────────────────────────
  useEffect(() => {
    if (isCartMode || !paymentLink) return;
    setIsLoadingPaymentLink(true);
    legacyApi.getPaymentLink(paymentLink)
      .then(res => {
        if (res.success) setPaymentLinkData(res.payment_link);
        else setPaymentLinkError(res.error || 'Failed to load payment link');
      })
      .catch(err => setPaymentLinkError(err.message || 'Failed to load payment link'))
      .finally(() => setIsLoadingPaymentLink(false));
  }, [paymentLink, isCartMode]);

  // Rebuild EVM api client for legacy mode
  useEffect(() => {
    if (isCartMode) return;
    if (walletClient?.account) {
      const client = new x402Client();
      registerExactEvmScheme(client, { signer: toEvmSigner(walletClient) });
      activeClientRef.current = wrapAxiosWithPayment(baseApiClient, client);
    } else {
      activeClientRef.current = null;
    }
  }, [walletClient, isCartMode]);

  // ── Wallet connect helpers ───────────────────────────────────────────────────
  const connectSolana = async () => {
    try {
      const phantom = (window as any).phantom?.solana;
      if (!phantom) throw new Error('Phantom wallet not found. Please install Phantom.');
      const resp = await phantom.connect();
      setSvmPhantom(phantom);
      setSvmAddress(resp.publicKey.toString());
    } catch (err: any) {
      console.error('Phantom connect error:', err);
    }
  };

  const connectStellar = async () => {
    try {
      await requestAccess();
      const result = await getAddress();
      if ('error' in result) throw new Error(result.error);
      setStellarAddress((result as any).address);
    } catch (err: any) {
      console.error('Freighter connect error:', err);
    }
  };

  const connectForFamily = (family: string) => {
    if (family === 'evm') connectWallet();
    else if (family === 'solana') connectSolana();
    else if (family === 'stellar') connectStellar();
  };

  const isWalletReadyForOption = (option: CheckoutPaymentOption | null): boolean => {
    if (!option) return false;
    if (option.chain_family === 'evm') return isEvmConnected;
    if (option.chain_family === 'solana') return Boolean(svmPhantom);
    if (option.chain_family === 'stellar') return Boolean(stellarAddress);
    return false;
  };

  const connectedAddressForOption = (option: CheckoutPaymentOption | null): string | null => {
    if (!option) return null;
    if (option.chain_family === 'evm') return evmAddress ?? null;
    if (option.chain_family === 'solana') return svmAddress;
    if (option.chain_family === 'stellar') return stellarAddress;
    return null;
  };

  // ── Payment handlers ─────────────────────────────────────────────────────────
  const handleCartPayment = async () => {
    if (!checkoutId || !activeClientRef.current) return;
    setPaymentStatus('processing');
    try {
      const result = await api.payCheckout(checkoutId, activeClientRef.current);
      setPaymentResult({ type: 'success', purchased: result.purchased, total: result.total });
      setPaymentStatus('completed');
    } catch (err: any) {
      setPaymentStatus('pending');
      setPaymentResult({ type: 'error', message: err.message || 'Payment failed' });
    }
  };

  const handleLegacyPayment = async () => {
    if (!isEvmConnected || !activeClientRef.current) return;
    setPaymentStatus('processing');
    try {
      const headers: any = {};
      if (paymentLink) headers['X-Payment-Link'] = paymentLink;
      const response = await activeClientRef.current.post("/api/pay/session", {}, { headers });
      setPaymentResult({ type: 'success', message: 'Payment successful!', session: response.data.session });
      setPaymentStatus('completed');
    } catch (error: any) {
      setPaymentStatus('pending');
      if (error.response?.status === 403 && evmAddress) {
        try {
          const riskData = await legacyApi.getWalletRiskAnalysis(evmAddress);
          if (riskData.success && riskData.data) {
            const { riskScore, riskLevel, recommendations = [] } = riskData.data;
            let msg = `PAYMENT BLOCKED\n\nRisk Score: ${riskScore}/100 (${riskLevel})`;
            if (recommendations.length > 0) msg += `\n\nReasons:\n${recommendations.map((r: string) => `• ${r}`).join('\n')}`;
            setPaymentResult({ type: 'error', message: msg });
          } else {
            setPaymentResult({ type: 'error', message: 'PAYMENT BLOCKED - Wallet exceeds risk threshold' });
          }
        } catch {
          setPaymentResult({ type: 'error', message: 'PAYMENT BLOCKED - High risk wallet detected' });
        }
      } else {
        setPaymentResult({ type: 'error', message: error.message || 'Failed to process payment' });
      }
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const formatAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const formatExpiry = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const currentAddress = isCartMode ? connectedAddressForOption(selectedOption) : (evmAddress ?? null);
  const currentIsConnected = isCartMode ? isWalletReadyForOption(selectedOption) : isEvmConnected;
  const isLoading = isCartMode ? isLoadingCheckout : isLoadingPaymentLink;
  const pageError = isCartMode ? checkoutError : paymentLinkError;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-6xl mx-auto px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-gradient-to-r from-amber-400 to-orange-400 rounded-lg flex items-center justify-center">
                <CreditCard className="h-5 w-5 text-white" />
              </div>
              <h1 className="text-xl font-bold text-gray-900">ZapPay</h1>
            </div>
            <div className="relative">
              {currentAddress ? (
                <div className="flex items-center space-x-3">
                  <div className="flex items-center space-x-2 bg-white px-3 py-2 rounded-lg border border-gray-200">
                    <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
                    <span className="text-sm font-medium text-gray-900">{formatAddress(currentAddress)}</span>
                  </div>
                  {(!isCartMode || selectedOption?.chain_family === 'evm') && (
                    <Button onClick={disconnectWallet} variant="outline" size="sm">Disconnect</Button>
                  )}
                </div>
              ) : !isCartMode ? (
                <Button
                  onClick={connectWallet}
                  disabled={isConnecting}
                  className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white"
                >
                  <Wallet className="h-4 w-4 mr-2" />
                  {isConnecting ? 'Connecting...' : 'Connect Wallet'}
                </Button>
              ) : null}
              {walletError && (
                <div className="absolute top-full left-0 mt-2 px-3 py-2 bg-red-100 border border-red-300 rounded-md text-red-700 text-sm z-10">
                  {walletError}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-8 py-8">

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-orange-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-600">Loading payment details...</p>
            </div>
          </div>
        )}

        {/* Error */}
        {pageError && !isLoading && (
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Error</h3>
              <p className="text-gray-600 mb-4">{pageError}</p>
              <Button onClick={() => navigate('/')} className="bg-orange-600 hover:bg-orange-700 text-white">Go Back</Button>
            </div>
          </div>
        )}

        {/* ── Cart Mode ── */}
        {isCartMode && !isLoading && !pageError && checkoutData && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

            {/* Left: Line items */}
            <div className="space-y-6">
              <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                <CardHeader>
                  <CardTitle className="flex items-center text-amber-600">
                    <ShoppingCart className="h-5 w-5 mr-2" />
                    Order Summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {checkoutData.line_items.map((item, i) => (
                      <div key={i} className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
                        <div>
                          <p className="font-medium text-gray-900">{item.name}</p>
                          <p className="text-sm text-gray-500">${item.unit_price.toFixed(2)} × {item.qty}</p>
                        </div>
                        <span className="font-medium text-gray-900">${item.subtotal.toFixed(2)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between items-center pt-2 font-bold text-gray-900">
                      <span>Total</span>
                      <span>${Number(checkoutData.total).toFixed(2)} {checkoutData.currency}</span>
                    </div>
                  </div>

                  {expirySecondsLeft !== null && (
                    <div className={`mt-4 flex items-center space-x-2 text-sm ${expirySecondsLeft < 60 ? 'text-red-600' : 'text-gray-500'}`}>
                      <Clock className="h-4 w-4" />
                      <span>Expires in {formatExpiry(expirySecondsLeft)}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Payment result / receipt */}
              {paymentResult && (
                <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                  <CardHeader>
                    <CardTitle className="text-amber-600">
                      {paymentResult.type === 'success' ? 'Payment Receipt' : 'Payment Result'}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className={`p-4 rounded-lg ${paymentResult.type === 'success' ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                      <div className="flex items-start space-x-2">
                        {paymentResult.type === 'success'
                          ? <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                          : <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />}
                        <div>
                          {paymentResult.type === 'success' ? (
                            <div className="space-y-2">
                              <p className="font-semibold text-green-800">Payment successful!</p>
                              {paymentResult.purchased?.map((item: any, i: number) => (
                                <div key={i} className="text-sm text-green-700">✓ {item.name} ×{item.qty} — ${item.subtotal.toFixed(2)}</div>
                              ))}
                            </div>
                          ) : (
                            <p className="font-medium text-red-800 whitespace-pre-line">{paymentResult.message}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right: Chain/token selector + pay */}
            <div className="space-y-6">
              <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                <CardHeader>
                  <CardTitle className="text-amber-600">Pay With</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Chain/token options */}
                  {paymentOptions.length === 0 ? (
                    <p className="text-gray-500 text-sm">No payment methods available from this merchant.</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2">
                      {paymentOptions.map((opt, i) => {
                        const isSelected = selectedOption?.chain_id === opt.chain_id && selectedOption?.token_symbol === opt.token_symbol;
                        return (
                          <button
                            key={i}
                            onClick={() => setSelectedOption(opt)}
                            disabled={paymentStatus !== 'pending'}
                            className={`w-full text-left p-3 rounded-lg border-2 transition-all ${isSelected ? FAMILY_COLORS[opt.chain_family] : 'border-gray-200 bg-white hover:border-gray-300'}`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center space-x-2">
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${FAMILY_BADGE[opt.chain_family]}`}>
                                  {opt.chain_family.toUpperCase()}
                                </span>
                                <span className="font-medium text-gray-900">{opt.chain_name}</span>
                                <span className="text-gray-600">{opt.token_symbol}</span>
                              </div>
                              <div className="flex items-center space-x-1">
                                {opt.is_testnet && (
                                  <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">testnet</span>
                                )}
                                {isSelected && <CheckCircle className="h-4 w-4 text-green-500" />}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Wallet connect + pay */}
                  {selectedOption && (
                    <div className="pt-2 space-y-3">
                      {!isWalletReadyForOption(selectedOption) ? (
                        <Button
                          onClick={() => connectForFamily(selectedOption.chain_family)}
                          disabled={isConnecting}
                          className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white"
                        >
                          <Wallet className="h-4 w-4 mr-2" />
                          {isConnecting ? 'Connecting...' : `Connect ${walletLabel(selectedOption.chain_family)}`}
                        </Button>
                      ) : (
                        <Button
                          onClick={handleCartPayment}
                          disabled={paymentStatus !== 'pending' || !activeClientRef.current}
                          className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white"
                        >
                          {paymentStatus === 'processing' ? (
                            <>
                              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                              Processing...
                            </>
                          ) : paymentStatus === 'completed' ? (
                            <><CheckCircle className="h-4 w-4 mr-2" />Payment Complete</>
                          ) : (
                            <><Wallet className="h-4 w-4 mr-2" />Pay ${Number(checkoutData.total).toFixed(2)} {checkoutData.currency}</>
                          )}
                        </Button>
                      )}

                      {connectedAddressForOption(selectedOption) && (
                        <p className="text-xs text-gray-500 text-center">
                          {walletLabel(selectedOption.chain_family)}: {formatAddress(connectedAddressForOption(selectedOption)!)}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-center space-x-2 text-xs text-gray-500 pt-2">
                    <Shield className="h-3 w-3" />
                    <span>Secure crypto payment powered by ZapPay</span>
                  </div>
                </CardContent>
              </Card>

              {/* Status tracker */}
              <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                <CardHeader>
                  <CardTitle className="text-amber-600">Payment Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {[
                      { label: 'Wallet Connected', done: currentIsConnected },
                      { label: 'Payment Processing', done: paymentStatus === 'processing' || paymentStatus === 'completed' },
                      { label: 'Transaction Complete', done: paymentStatus === 'completed' },
                    ].map(({ label, done }) => (
                      <div key={label} className="flex items-center space-x-3">
                        <div className={`w-3 h-3 rounded-full ${done ? 'bg-orange-500' : 'bg-gray-300'}`}></div>
                        <span className="text-sm">{label}</span>
                        {done && <CheckCircle className="h-4 w-4 text-orange-600" />}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ── Legacy Payment Link Mode ── */}
        {!isCartMode && !isLoadingPaymentLink && !paymentLinkError && paymentLinkData && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-6">
              <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                <CardHeader>
                  <CardTitle className="flex items-center text-amber-600">
                    <CreditCard className="h-5 w-5 mr-2" />
                    Payment Terminal
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="bg-white rounded-lg shadow-lg p-6 border-2 border-dashed border-amber-200">
                    <div className="text-center space-y-6">
                      <div className="flex items-center justify-center">
                        {paymentStatus === 'pending' && (
                          <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                            <CreditCard className="h-6 w-6 text-gray-400" />
                          </div>
                        )}
                        {paymentStatus === 'processing' && (
                          <div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center animate-pulse">
                            <div className="w-6 h-6 border-2 border-orange-600 border-t-transparent rounded-full animate-spin"></div>
                          </div>
                        )}
                        {paymentStatus === 'completed' && (
                          <div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center">
                            <CheckCircle className="h-6 w-6 text-orange-600" />
                          </div>
                        )}
                      </div>
                      <div>
                        <h3 className="text-xl font-semibold text-gray-900">{paymentLinkData.product_name}</h3>
                      </div>
                      <div className="text-3xl font-bold text-gray-900">
                        ${paymentLinkData.pricing.toFixed(2)} USDC
                      </div>
                      <Button
                        onClick={handleLegacyPayment}
                        disabled={!isEvmConnected || paymentStatus !== 'pending'}
                        className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white"
                      >
                        {paymentStatus === 'pending' && <><Wallet className="h-4 w-4 mr-2" />Pay with Crypto</>}
                        {paymentStatus === 'processing' && <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>Processing Payment...</>}
                        {paymentStatus === 'completed' && <><CheckCircle className="h-4 w-4 mr-2" />Payment Complete</>}
                      </Button>
                      <div className="flex items-center justify-center space-x-2 text-xs text-gray-500">
                        <Shield className="h-3 w-3" />
                        <span>Secure crypto payment powered by ZapPay</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {paymentResult && (
                <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                  <CardHeader><CardTitle className="text-amber-600">Payment Result</CardTitle></CardHeader>
                  <CardContent>
                    <div className={`p-4 rounded-lg ${paymentResult.type === 'success' ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                      <div className="flex items-start space-x-2">
                        {paymentResult.type === 'success'
                          ? <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                          : <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />}
                        <div className={`font-medium whitespace-pre-line ${paymentResult.type === 'success' ? 'text-green-800' : 'text-red-800'}`}>
                          {paymentResult.message}
                        </div>
                      </div>
                      {paymentResult.session && (
                        <div className="mt-3 text-sm text-gray-600">
                          <p><strong>Session ID:</strong> {paymentResult.session.id}</p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="space-y-6">
              <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                <CardHeader><CardTitle className="text-amber-600">Payment Details</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-gray-600">Product</span>
                      <span className="font-medium">{paymentLinkData.product_name}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-gray-600">Amount</span>
                      <span className="font-medium">${paymentLinkData.pricing.toFixed(2)} USDC</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-gray-600">Network Fee</span>
                      <span className="font-medium">Free! Subsidy by ZapPay</span>
                    </div>
                    <div className="border-t pt-3">
                      <div className="flex justify-between items-center">
                        <span className="text-gray-900 font-semibold">Total</span>
                        <span className="text-gray-900 font-semibold">${paymentLinkData.pricing.toFixed(2)} USDC</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
                <CardHeader><CardTitle className="text-amber-600">Payment Status</CardTitle></CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {[
                      { label: 'Wallet Connection', done: isEvmConnected },
                      { label: 'Payment Processing', done: paymentStatus === 'processing' || paymentStatus === 'completed' },
                      { label: 'Transaction Complete', done: paymentStatus === 'completed' },
                    ].map(({ label, done }) => (
                      <div key={label} className="flex items-center space-x-3">
                        <div className={`w-3 h-3 rounded-full ${done ? 'bg-orange-500' : 'bg-gray-300'}`}></div>
                        <span className="text-sm">{label}</span>
                        {done && <CheckCircle className="h-4 w-4 text-orange-600" />}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
