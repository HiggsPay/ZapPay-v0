import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/services/api';

function isValidWebhookUrl(url: string): boolean {
  try {
    const p = new URL(url);
    const local = p.hostname === 'localhost' || p.hostname === '127.0.0.1';
    return p.protocol === 'https:' || (p.protocol === 'http:' && local);
  } catch {
    return false;
  }
}

const EXAMPLE_PAYLOAD = JSON.stringify(
  {
    event: 'transaction.confirmed',
    transaction_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    tx_hash: '0x...',
    network: 'eip155:84532',
    amount: 10.0,
    currency: 'USD',
    crypto_amount: 10.0,
    crypto_currency: 'USDC',
    wallet_address: '0x...',
    payment_link_id: null,
    payment_link_hash: null,
    owner_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    session_id: null,
    confirmed_at: '2026-04-28T00:00:00.000Z',
  },
  null,
  2
);

const VERIFY_SNIPPET = `// Node.js HMAC verification
const crypto = require('crypto');

function verifyZapPaySignature(req, secret) {
  const sig = req.headers['x-zappay-signature'];   // "sha256=<hex>"
  const ts  = req.headers['x-zappay-timestamp'];   // Unix seconds
  const computed = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(\`\${ts}.\${req.rawBody}\`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(computed));
}`;

interface Props {
  initialWebhookUrl: string | null;
}

export function WebhookSettings({ initialWebhookUrl }: Props) {
  const { toast } = useToast();

  const [savedWebhookUrl, setSavedWebhookUrl] = useState(initialWebhookUrl ?? '');
  const [webhookUrlInput, setWebhookUrlInput] = useState(initialWebhookUrl ?? '');
  const [urlError, setUrlError] = useState('');
  const [saving, setSaving] = useState(false);

  const [webhookSecret, setWebhookSecret] = useState('');
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [revealLoading, setRevealLoading] = useState(false);

  const [testResult, setTestResult] = useState<{ ok: boolean; status: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  async function handleReveal() {
    setRevealLoading(true);
    try {
      const res = await api.getWebhookSecret();
      setWebhookSecret(res.webhook_secret ?? '');
      setSecretRevealed(true);
    } catch {
      toast({ title: 'Failed to reveal secret', variant: 'destructive' });
    } finally {
      setRevealLoading(false);
    }
  }

  function handleCopySecret() {
    if (webhookSecret) {
      navigator.clipboard.writeText(webhookSecret);
      toast({ title: 'Copied to clipboard' });
    }
  }

  async function handleSave() {
    const url = webhookUrlInput.trim();

    if (url === '') {
      // Allow clearing the URL
      setSaving(true);
      try {
        await api.updateWebhookUrl(null);
        setSavedWebhookUrl('');
        setTestResult(null);
        toast({ title: 'Webhook endpoint removed' });
      } catch {
        toast({ title: 'Failed to save', variant: 'destructive' });
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!isValidWebhookUrl(url)) {
      setUrlError('Must be https:// (or http://localhost for local testing)');
      return;
    }
    setUrlError('');
    setSaving(true);
    try {
      await api.updateWebhookUrl(url);
      setSavedWebhookUrl(url);
      setTestResult(null);
      toast({ title: 'Webhook endpoint saved' });
    } catch {
      toast({ title: 'Failed to save', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testWebhook();
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, status: 0, error: err?.response?.data?.error ?? err.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>
          Receive real-time notifications when payments are confirmed. ZapPay signs every delivery
          with HMAC-SHA256 so you can verify authenticity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">

        {/* Signing secret */}
        <div className="space-y-2">
          <Label className="font-medium">Signing Secret</Label>
          <p className="text-xs text-muted-foreground">
            Use this to verify that webhook deliveries come from ZapPay. Auto-generated — cannot be changed in this release.
          </p>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={secretRevealed ? webhookSecret : '••••••••••••••••••••••••••••••••••••••••'}
              className="font-mono text-sm bg-muted"
            />
            {!secretRevealed ? (
              <Button variant="outline" size="sm" onClick={handleReveal} disabled={revealLoading} className="shrink-0">
                {revealLoading ? 'Loading…' : 'Reveal'}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={handleCopySecret} className="shrink-0">
                Copy
              </Button>
            )}
          </div>
        </div>

        {/* Endpoint URL */}
        <div className="space-y-2">
          <Label htmlFor="webhook-url" className="font-medium">Endpoint URL</Label>
          <p className="text-xs text-muted-foreground">
            ZapPay will POST signed JSON payloads to this URL when a transaction is confirmed.
          </p>
          <Input
            id="webhook-url"
            placeholder="https://yoursite.com/webhooks/zappay"
            value={webhookUrlInput}
            onChange={e => { setWebhookUrlInput(e.target.value); setUrlError(''); }}
            className={`font-mono text-sm ${urlError ? 'border-destructive' : ''}`}
          />
          {urlError && <p className="text-xs text-destructive">{urlError}</p>}
          {savedWebhookUrl && savedWebhookUrl !== webhookUrlInput && (
            <p className="text-xs text-muted-foreground">
              Currently saved: <span className="font-mono">{savedWebhookUrl}</span>
            </p>
          )}
        </div>

        {/* Action row */}
        <div className="flex items-center gap-3 flex-wrap">
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? 'Saving…' : 'Save Endpoint'}
          </Button>
          {savedWebhookUrl && (
            <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
              {testing ? 'Sending…' : 'Send Test Event'}
            </Button>
          )}
          {testResult && (
            <Badge variant={testResult.ok ? 'default' : 'destructive'} className="text-xs">
              {testResult.ok
                ? `Delivered (HTTP ${testResult.status})`
                : `Failed${testResult.status ? ` (HTTP ${testResult.status})` : ''}: ${testResult.error ?? 'Unknown error'}`}
            </Badge>
          )}
        </div>

        {/* Example payload */}
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground transition-colors">
            Example payload & verification
          </summary>
          <div className="mt-3 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Payload shape (<code>transaction.confirmed</code>):</p>
              <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto leading-relaxed">{EXAMPLE_PAYLOAD}</pre>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">HMAC verification (Node.js):</p>
              <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto leading-relaxed">{VERIFY_SNIPPET}</pre>
            </div>
          </div>
        </details>

      </CardContent>
    </Card>
  );
}
