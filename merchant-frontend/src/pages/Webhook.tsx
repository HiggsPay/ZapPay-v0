import { useEffect, useState } from 'react';
import { api } from '@/services/api';
import { WebhookSettings } from '@/pages/settings/WebhookSettings';

export function Webhook() {
  const [initialWebhookUrl, setInitialWebhookUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getProfile()
      .then(res => setInitialWebhookUrl(res.profile?.webhook_url ?? null))
      .catch(() => setInitialWebhookUrl(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Webhooks</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Receive real-time notifications when payments are confirmed.
        </p>
      </div>
      <WebhookSettings initialWebhookUrl={initialWebhookUrl} />
    </div>
  );
}
