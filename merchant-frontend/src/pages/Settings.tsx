import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { api, type TokenConfig } from '@/services/api';

type ChainFamily = 'evm' | 'solana' | 'stellar';

interface TokenKey {
  chain_id?: string;
  chainId?: string;
  token_symbol?: string;
  tokenSymbol?: string;
}

function tokenKey(t: TokenKey): string {
  const chainId = t.chain_id ?? t.chainId ?? '';
  const symbol = t.token_symbol ?? t.tokenSymbol ?? '';
  return `${chainId}:${symbol}`;
}

function groupByChain(tokens: TokenConfig[]): Map<string, TokenConfig[]> {
  const map = new Map<string, TokenConfig[]>();
  for (const t of tokens) {
    const existing = map.get(t.chainId) ?? [];
    existing.push(t);
    map.set(t.chainId, existing);
  }
  return map;
}

function isValidEvmAddress(v: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isValidSolanaAddress(v: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

function isValidStellarAddress(v: string) {
  return /^G[A-Z2-7]{55}$/.test(v);
}

export function Settings() {
  const { toast } = useToast();

  const [supported, setSupported] = useState<TokenConfig[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showConfirm, setShowConfirm] = useState(false);

  // Chain family toggles — whether merchant wants to accept this family
  const [evmEnabled, setEvmEnabled] = useState(false);
  const [solanaEnabled, setSolanaEnabled] = useState(false);
  const [stellarEnabled, setStellarEnabled] = useState(false);

  // Wallet inputs (unsaved draft)
  const [evmWalletInput, setEvmWalletInput] = useState('');
  const [solanaWalletInput, setSolanaWalletInput] = useState('');
  const [stellarWalletInput, setStellarWalletInput] = useState('');

  // Saved (locked) wallet addresses from DB
  const [savedEvmWallet, setSavedEvmWallet] = useState('');
  const [savedSolanaWallet, setSavedSolanaWallet] = useState('');
  const [savedStellarWallet, setSavedStellarWallet] = useState('');

  // Validation errors
  const [evmError, setEvmError] = useState('');
  const [solanaError, setSolanaError] = useState('');
  const [stellarError, setStellarError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [tokensRes, configRes, profileRes] = await Promise.all([
          api.getSupportedTokens(),
          api.getPaymentConfig(),
          api.getProfile(),
        ]);

        setSupported(tokensRes.supported);

        const enabledSet = new Set<string>(
          (configRes.configs ?? []).map((c: { chain_id: string; token_symbol: string }) => tokenKey(c))
        );
        setEnabled(enabledSet);

        const { wallet_address, solana_wallet_address, stellar_wallet_address } = profileRes.profile;
        setSavedEvmWallet(wallet_address ?? '');
        setSavedSolanaWallet(solana_wallet_address ?? '');
        setSavedStellarWallet(stellar_wallet_address ?? '');

        const hasEvmTokens = (configRes.configs ?? []).some((c: { chain_id: string }) => c.chain_id.startsWith('eip155:'));
        const hasSolanaTokens = (configRes.configs ?? []).some((c: { chain_id: string }) => c.chain_id.startsWith('solana:'));
        const hasStellarTokens = (configRes.configs ?? []).some((c: { chain_id: string }) => c.chain_id.startsWith('stellar:'));

        setEvmEnabled(!!wallet_address || hasEvmTokens);
        setSolanaEnabled(!!solana_wallet_address || hasSolanaTokens);
        setStellarEnabled(!!stellar_wallet_address || hasStellarTokens);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  function toggleToken(t: TokenConfig) {
    // Prevent disabling a token if it was previously saved
    const k = tokenKey(t);
    setEnabled(prev => {
      const next = new Set(prev);
      if (next.has(k)) {
        next.delete(k);
      } else {
        next.add(k);
      }
      return next;
    });
  }

  function handleFamilyToggle(family: ChainFamily, value: boolean) {
    // Cannot toggle off a family that already has a saved wallet
    if (!value) {
      if (family === 'evm' && savedEvmWallet) return;
      if (family === 'solana' && savedSolanaWallet) return;
      if (family === 'stellar' && savedStellarWallet) return;
    }
    if (family === 'evm') { setEvmEnabled(value); setEvmError(''); }
    if (family === 'solana') { setSolanaEnabled(value); setSolanaError(''); }
    if (family === 'stellar') { setStellarEnabled(value); setStellarError(''); }
  }

  function validate(): boolean {
    let valid = true;

    if (evmEnabled && !savedEvmWallet) {
      const val = evmWalletInput.trim();
      if (!val) {
        setEvmError('EVM wallet address is required when EVM is enabled.');
        valid = false;
      } else if (!isValidEvmAddress(val)) {
        setEvmError('Invalid EVM address. Must be 0x followed by 40 hex characters.');
        valid = false;
      } else {
        setEvmError('');
      }
    }

    if (solanaEnabled && !savedSolanaWallet) {
      const val = solanaWalletInput.trim();
      if (!val) {
        setSolanaError('Solana wallet address is required when Solana is enabled.');
        valid = false;
      } else if (!isValidSolanaAddress(val)) {
        setSolanaError('Invalid Solana address. Must be a base58 public key.');
        valid = false;
      } else {
        setSolanaError('');
      }
    }

    if (stellarEnabled && !savedStellarWallet) {
      const val = stellarWalletInput.trim();
      if (!val) {
        setStellarError('Stellar wallet address is required when Stellar is enabled.');
        valid = false;
      } else if (!isValidStellarAddress(val)) {
        setStellarError('Invalid Stellar address. Must start with G followed by 55 uppercase characters.');
        valid = false;
      } else {
        setStellarError('');
      }
    }

    // Check that at least one token is selected per enabled family
    const hasEvmToken = Array.from(enabled).some(k => k.startsWith('eip155:'));
    const hasSolanaToken = Array.from(enabled).some(k => k.startsWith('solana:'));
    const hasStellarToken = Array.from(enabled).some(k => k.startsWith('stellar:'));

    if (evmEnabled && !hasEvmToken) {
      toast({ title: 'Select at least one EVM token', variant: 'destructive' });
      valid = false;
    }
    if (solanaEnabled && !hasSolanaToken) {
      toast({ title: 'Select at least one Solana token', variant: 'destructive' });
      valid = false;
    }
    if (stellarEnabled && !hasStellarToken) {
      toast({ title: 'Select at least one Stellar token', variant: 'destructive' });
      valid = false;
    }

    return valid;
  }

  function handleSaveClick() {
    if (!validate()) return;
    setShowConfirm(true);
  }

  async function confirmSave() {
    setShowConfirm(false);
    setSaving(true);
    try {
      // Save any new wallet addresses (only if not already saved)
      if (evmEnabled && !savedEvmWallet && evmWalletInput.trim()) {
        await api.updateWalletAddress(evmWalletInput.trim());
        setSavedEvmWallet(evmWalletInput.trim());
      }
      if (solanaEnabled && !savedSolanaWallet && solanaWalletInput.trim()) {
        await api.updateSolanaWalletAddress(solanaWalletInput.trim());
        setSavedSolanaWallet(solanaWalletInput.trim());
      }
      if (stellarEnabled && !savedStellarWallet && stellarWalletInput.trim()) {
        await api.updateStellarWalletAddress(stellarWalletInput.trim());
        setSavedStellarWallet(stellarWalletInput.trim());
      }

      // Save token config — only include tokens from enabled families
      const configs = Array.from(enabled)
        .filter(k => {
          if (k.startsWith('eip155:') && !evmEnabled) return false;
          if (k.startsWith('solana:') && !solanaEnabled) return false;
          if (k.startsWith('stellar:') && !stellarEnabled) return false;
          return true;
        })
        .map(k => {
          const lastColon = k.lastIndexOf(':');
          return { chain_id: k.substring(0, lastColon), token_symbol: k.substring(lastColon + 1) };
        });

      await api.updatePaymentConfig(configs);
      toast({ title: 'Payment settings saved', description: `${configs.length} payment method(s) enabled.` });
    } catch {
      toast({ title: 'Failed to save', description: 'Please try again.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const evmTokens = supported.filter(t => t.chainFamily === 'evm');
  const solanaTokens = supported.filter(t => t.chainFamily === 'solana');
  const stellarTokens = supported.filter(t => t.chainFamily === 'stellar');

  const evmByChain = groupByChain(evmTokens);
  const solanaByChain = groupByChain(solanaTokens);
  const stellarByChain = groupByChain(stellarTokens);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payment Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure which chains and tokens you accept. Wallet addresses are permanent once saved — contact admin to change them.
        </p>
      </div>

      {/* Chain family toggles + wallet inputs */}
      <Card>
        <CardHeader>
          <CardTitle>Accepted Chain Families</CardTitle>
          <CardDescription>
            Enable a chain family to accept payments on it. You must provide a receiving wallet address.
            Once saved, the wallet address cannot be changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">

          {/* EVM */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Switch
                  id="evm-family"
                  checked={evmEnabled}
                  onCheckedChange={v => handleFamilyToggle('evm', v)}
                  disabled={!!savedEvmWallet}
                />
                <Label htmlFor="evm-family" className="font-medium cursor-pointer">
                  EVM <span className="text-muted-foreground font-normal text-xs">(Ethereum, Base, Polygon, Arbitrum, Optimism, BSC)</span>
                </Label>
              </div>
              {savedEvmWallet && <Badge variant="secondary" className="text-xs">Wallet set</Badge>}
            </div>
            {evmEnabled && (
              <div className="pl-9 space-y-1">
                {savedEvmWallet ? (
                  <div className="flex items-center gap-2">
                    <Input value={savedEvmWallet} readOnly className="font-mono text-sm bg-muted" />
                    <Badge variant="outline" className="text-xs shrink-0">Locked</Badge>
                  </div>
                ) : (
                  <>
                    <Input
                      placeholder="0x..."
                      value={evmWalletInput}
                      onChange={e => { setEvmWalletInput(e.target.value); setEvmError(''); }}
                      className={`font-mono text-sm ${evmError ? 'border-destructive' : ''}`}
                    />
                    {evmError && <p className="text-xs text-destructive">{evmError}</p>}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Solana */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Switch
                  id="solana-family"
                  checked={solanaEnabled}
                  onCheckedChange={v => handleFamilyToggle('solana', v)}
                  disabled={!!savedSolanaWallet}
                />
                <Label htmlFor="solana-family" className="font-medium cursor-pointer">
                  Solana <span className="text-muted-foreground font-normal text-xs">(SPL tokens)</span>
                </Label>
              </div>
              {savedSolanaWallet && <Badge variant="secondary" className="text-xs">Wallet set</Badge>}
            </div>
            {solanaEnabled && (
              <div className="pl-9 space-y-1">
                {savedSolanaWallet ? (
                  <div className="flex items-center gap-2">
                    <Input value={savedSolanaWallet} readOnly className="font-mono text-sm bg-muted" />
                    <Badge variant="outline" className="text-xs shrink-0">Locked</Badge>
                  </div>
                ) : (
                  <>
                    <Input
                      placeholder="Base58 public key…"
                      value={solanaWalletInput}
                      onChange={e => { setSolanaWalletInput(e.target.value); setSolanaError(''); }}
                      className={`font-mono text-sm ${solanaError ? 'border-destructive' : ''}`}
                    />
                    {solanaError && <p className="text-xs text-destructive">{solanaError}</p>}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Stellar */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Switch
                  id="stellar-family"
                  checked={stellarEnabled}
                  onCheckedChange={v => handleFamilyToggle('stellar', v)}
                  disabled={!!savedStellarWallet}
                />
                <Label htmlFor="stellar-family" className="font-medium cursor-pointer">
                  Stellar <span className="text-muted-foreground font-normal text-xs">(SEP-41 tokens)</span>
                </Label>
              </div>
              {savedStellarWallet && <Badge variant="secondary" className="text-xs">Wallet set</Badge>}
            </div>
            {stellarEnabled && (
              <div className="pl-9 space-y-1">
                {savedStellarWallet ? (
                  <div className="flex items-center gap-2">
                    <Input value={savedStellarWallet} readOnly className="font-mono text-sm bg-muted" />
                    <Badge variant="outline" className="text-xs shrink-0">Locked</Badge>
                  </div>
                ) : (
                  <>
                    <Input
                      placeholder="G… Stellar public key"
                      value={stellarWalletInput}
                      onChange={e => { setStellarWalletInput(e.target.value); setStellarError(''); }}
                      className={`font-mono text-sm ${stellarError ? 'border-destructive' : ''}`}
                    />
                    {stellarError && <p className="text-xs text-destructive">{stellarError}</p>}
                  </>
                )}
              </div>
            )}
          </div>

        </CardContent>
      </Card>

      {/* Token selection — only shown for enabled families */}
      {(evmEnabled || solanaEnabled || stellarEnabled) && (
        <Card>
          <CardHeader>
            <CardTitle>Accepted Payment Methods</CardTitle>
            <CardDescription>Choose which tokens your customers can pay with on each enabled chain.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {evmEnabled && evmByChain.size > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm">EVM Chains</h3>
                  <Badge variant="outline" className="text-xs">EIP-3009 + Permit2</Badge>
                </div>
                {Array.from(evmByChain.entries()).map(([chainId, tokens]) => (
                  <div key={chainId} className="border rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{tokens[0].chainName}</span>
                      {tokens[0].isTestnet && <Badge variant="secondary" className="text-xs">Testnet</Badge>}
                    </div>
                    <div className="flex flex-wrap gap-4">
                      {tokens.map(t => (
                        <div key={tokenKey(t)} className="flex items-center gap-2">
                          <Switch
                            id={tokenKey(t)}
                            checked={enabled.has(tokenKey(t))}
                            onCheckedChange={() => toggleToken(t)}
                          />
                          <Label htmlFor={tokenKey(t)} className="text-sm cursor-pointer">{t.tokenSymbol}</Label>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {solanaEnabled && solanaByChain.size > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm">Solana</h3>
                  <Badge variant="outline" className="text-xs">SPL tokens</Badge>
                </div>
                {Array.from(solanaByChain.entries()).map(([chainId, tokens]) => (
                  <div key={chainId} className="border rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{tokens[0].chainName}</span>
                      {tokens[0].isTestnet && <Badge variant="secondary" className="text-xs">Devnet</Badge>}
                    </div>
                    <div className="flex flex-wrap gap-4">
                      {tokens.map(t => (
                        <div key={tokenKey(t)} className="flex items-center gap-2">
                          <Switch
                            id={tokenKey(t)}
                            checked={enabled.has(tokenKey(t))}
                            onCheckedChange={() => toggleToken(t)}
                          />
                          <Label htmlFor={tokenKey(t)} className="text-sm cursor-pointer">{t.tokenSymbol}</Label>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {stellarEnabled && stellarByChain.size > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm">Stellar</h3>
                  <Badge variant="outline" className="text-xs">SEP-41 tokens</Badge>
                </div>
                {Array.from(stellarByChain.entries()).map(([chainId, tokens]) => (
                  <div key={chainId} className="border rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{tokens[0].chainName}</span>
                      {tokens[0].isTestnet && <Badge variant="secondary" className="text-xs">Testnet</Badge>}
                    </div>
                    <div className="flex flex-wrap gap-4">
                      {tokens.map(t => (
                        <div key={tokenKey(t)} className="flex items-center gap-2">
                          <Switch
                            id={tokenKey(t)}
                            checked={enabled.has(tokenKey(t))}
                            onCheckedChange={() => toggleToken(t)}
                          />
                          <Label htmlFor={tokenKey(t)} className="text-sm cursor-pointer">{t.tokenSymbol}</Label>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="pt-2">
              <Button onClick={handleSaveClick} disabled={saving} className="w-full sm:w-auto">
                {saving ? 'Saving…' : 'Save Payment Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Irreversible confirmation dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This action is irreversible</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                Once saved, your wallet address(es) are permanently locked to your account.
                You will <strong>not</strong> be able to change them yourself.
              </span>
              <span className="block">
                To update a wallet address in the future, you must contact the admin.
              </span>
              <span className="block font-medium text-foreground">
                Are you sure you want to proceed?
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSave}>Yes, save permanently</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
