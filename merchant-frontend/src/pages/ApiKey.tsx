import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/services/api';
import { Copy, Check, Eye } from 'lucide-react';

type Stage = 'hidden' | 'revealed' | 'copied';

export function ApiKey() {
  const [apiKey, setApiKey] = useState('');
  const [stage, setStage] = useState<Stage>('hidden');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getProfile()
      .then((res) => { if (res.profile.api_key) setApiKey(res.profile.api_key); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleClick() {
    if (stage === 'hidden') {
      setStage('revealed');
    } else if (stage === 'revealed') {
      await navigator.clipboard.writeText(apiKey);
      setStage('copied');
      setTimeout(() => setStage('revealed'), 2000);
    }
  }

  const buttonLabel =
    stage === 'hidden' ? 'Reveal' :
    stage === 'revealed' ? 'Copy' :
    'Copied!';

  const ButtonIcon =
    stage === 'hidden' ? Eye :
    stage === 'copied' ? Check :
    Copy;

  if (loading) {
    return (
      <div className="p-6 flex items-center space-x-2 text-gray-500">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-orange-600"></div>
        <span>Loading…</span>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 text-left">API Key</h1>
          <p className="text-gray-600 mt-2">
            Use this key to authenticate server-to-server requests to the ZapPay API.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Secret Key</CardTitle>
          <CardDescription>
            Pass this as the <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">X-API-Key</code> header
            when creating checkout sessions from your backend. Keep it secret — treat it like a password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              type={stage === 'hidden' ? 'password' : 'text'}
              value={apiKey}
              readOnly
              className="font-mono text-sm"
              placeholder="No API key found"
            />
            <Button
              onClick={handleClick}
              disabled={!apiKey}
              className="shrink-0 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 text-white gap-2"
            >
              <ButtonIcon className="h-4 w-4" />
              {buttonLabel}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground transition-colors">
              Example usage
            </summary>
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-1">Create a checkout session from your backend server:</p>
              <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto leading-relaxed">{`POST /api/checkout
X-API-Key: ${apiKey && stage !== 'hidden' ? apiKey : 'zp_live_...'}
Content-Type: application/json

{
  "items": [{ "product_id": "<your-product-id>", "qty": 1 }],
  "success_url": "https://yoursite.com/thank-you",
  "cancel_url": "https://yoursite.com/cancel"
}`}</pre>
            </div>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
