import { useState, useEffect } from 'react';
import { api, type BalanceRow } from '@/services/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Wallet,
  RefreshCw,
  Eye,
  EyeOff,
  AlertCircle,
  Loader2,
} from 'lucide-react';

function chainLabel(chainId: string): string {
  const map: Record<string, string> = {
    'eip155:84532':   'Base Sepolia',
    'eip155:8453':    'Base',
    'eip155:1':       'Ethereum',
    'solana:devnet':  'Solana Devnet',
    'solana:mainnet': 'Solana',
    'stellar:testnet':'Stellar Testnet',
    'stellar:mainnet':'Stellar',
  };
  return map[chainId] ?? chainId;
}

export function Balance() {
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [totalUSD, setTotalUSD] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBalances, setShowBalances] = useState(true);

  async function fetchBalances() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getBalance();
      setBalances(res.balances ?? []);
      setTotalUSD(res.total_usd ?? 0);
    } catch {
      setError('Failed to load balances.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await fetchBalances();
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => { fetchBalances(); }, []);

  return (
    <div className="p-4 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 text-left">Balance</h1>
          <p className="text-gray-600 mt-2">Your cryptocurrency holdings across all chains.</p>
        </div>
        <Button
          variant="outline"
          className="border-amber-300 hover:bg-amber-50"
          onClick={handleSync}
          disabled={syncing || loading}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
          Sync
        </Button>
      </div>

      {/* Total Portfolio Card */}
      <Card className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center">
              <Wallet className="h-5 w-5 mr-2 text-amber-600" />
              Total Portfolio Value
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="bg-transparent hover:bg-transparent border-none shadow-none text-gray-600 hover:text-gray-900"
              onClick={() => setShowBalances(!showBalances)}
            >
              {showBalances ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-amber-600" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </div>
          ) : (
            <p className="text-3xl font-bold text-gray-900 text-center">
              {showBalances
                ? `$${totalUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : '••••••'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Individual balance cards */}
      {!loading && !error && (
        balances.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Wallet className="h-12 w-12 mx-auto mb-4 opacity-30" />
            <p className="text-sm">No balance records yet.</p>
            <p className="text-xs mt-1">Balances are recorded as payments come in.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {balances.map((b) => (
              <Card
                key={b.id}
                className="border-amber-100 bg-gradient-to-br from-white to-amber-50/30 hover:shadow-md transition-shadow"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg font-semibold">{b.currency}</CardTitle>
                    <Badge variant="secondary" className="text-xs capitalize">
                      {chainLabel(b.chain_id)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <p className="text-2xl font-bold text-gray-900">
                      {showBalances ? Number(b.amount).toFixed(4) : '••••'}
                    </p>
                    <p className="text-sm text-gray-500">
                      {showBalances && b.usd_value != null
                        ? `≈ $${Number(b.usd_value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : showBalances ? 'USD value unknown' : '••••••'}
                    </p>
                    <p className="text-xs text-gray-400">
                      Updated {new Date(b.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
    </div>
  );
}
