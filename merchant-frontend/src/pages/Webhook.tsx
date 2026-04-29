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
          <h1 className="text-3xl font-bold text-gray-900 text-left">Webhooks</h1>
          <p className="text-gray-600 mt-2">
            Receive real-time notifications when payments are confirmed.
          </p>
        </div>
      </div>
      <WebhookSettings initialWebhookUrl={initialWebhookUrl} />
    </div>
  );
}
