import { useState, useEffect, useCallback } from 'react';
import { api, type Checkout } from '@/services/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ShoppingCart,
  Copy,
  ExternalLink,
  AlertCircle,
  ChevronDown,
  X,
  ArrowUp,
  Settings,
  MoreVertical,
  Plus
} from 'lucide-react';

type CheckoutStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

const STATUS_STYLES: Record<CheckoutStatus, string> = {
  pending: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  paid: 'bg-green-50 text-green-700 border-green-200',
  expired: 'bg-gray-100 text-gray-500 border-gray-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
};

interface CheckoutStats {
  pending: number;
  paid: number;
  expired: number;
  cancelled: number;
  total_revenue: number;
}

export function Checkouts() {
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [stats, setStats] = useState<CheckoutStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Status filter
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Pagination
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const LIMIT = 20;

  // Table selection
  const [selectAll, setSelectAll] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  const fetchCheckouts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: { status?: string; limit: number; offset: number } = { limit: LIMIT, offset };
      if (statusFilter !== 'all') params.status = statusFilter;
      const res = await api.listCheckouts(params);
      setCheckouts(res.checkouts ?? []);
      setTotal(res.count ?? 0);
      setStats(res.stats ?? null);

      // Clear selections when data changes
      setSelectedItems(new Set());
      setSelectAll(false);
    } catch {
      setError('Failed to load checkout sessions.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, offset]);

  useEffect(() => {
    fetchCheckouts();
  }, [fetchCheckouts]);

  async function expireCheckout(id: string) {
    try {
      await api.expireCheckout(id);
      fetchCheckouts();
    } catch { }
  }

  const frontendBase = import.meta.env.VITE_API_BASE_URL?.replace(':3001', ':5174') || 'http://localhost:5174';
  function checkoutUrl(id: string) { return `${frontendBase}/c/${id}`; }

  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedItems(new Set());
      setSelectAll(false);
    } else {
      const allIds = new Set(checkouts.map(co => co.id));
      setSelectedItems(allIds);
      setSelectAll(true);
    }
  };

  const handleSelectItem = (id: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedItems(newSelected);
    setSelectAll(newSelected.size === checkouts.length && checkouts.length > 0);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) { }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const totalCheckouts = stats ? stats.pending + stats.paid + stats.expired + stats.cancelled : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 text-left">Checkout Sessions</h1>
          <p className="text-gray-600 mt-2">
            Monitor hosted checkout sessions created via the API.
          </p>
        </div>
      </div>

      {/* Stats Summary Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { id: 'all', label: 'All', value: totalCheckouts },
            { id: 'pending', label: 'Pending', value: stats.pending },
            { id: 'paid', label: 'Paid', value: stats.paid },
            { id: 'expired', label: 'Expired', value: stats.expired },
            { id: 'cancelled', label: 'Cancelled', value: stats.cancelled },
          ].map(s => (
            <Card
              key={s.id}
              className={`border-2 cursor-pointer hover:shadow-md transition-shadow ${statusFilter === s.id ? 'border-orange-200 bg-orange-50' : 'border border-gray-200'}`}
              onClick={() => { setStatusFilter(s.id); setOffset(0); }}
            >
              <CardContent className="p-3">
                <div className="text-center">
                  <p className={`text-sm font-medium ${statusFilter === s.id ? 'text-orange-700' : 'text-gray-600'}`}>{s.label}</p>
                  <p className={`text-xl font-bold ${statusFilter === s.id ? 'text-orange-900' : 'text-gray-900'}`}>
                    {loading ? '...' : s.value}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="text-xs">
            <Plus className="h-3 w-3 mr-1" />
            Created
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => {
              if (statusFilter !== 'all') {
                setStatusFilter('all');
                setOffset(0);
              }
            }}
          >
            Status: {statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}
            <ChevronDown className="h-3 w-3 ml-1" />
            {statusFilter !== 'all' && (
              <X
                className="h-3 w-3 ml-1 text-gray-400 hover:text-gray-600"
                onClick={(e) => {
                  e.stopPropagation();
                  setStatusFilter('all');
                  setOffset(0);
                }}
              />
            )}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="text-xs">
            <ArrowUp className="h-3 w-3 mr-1" />
            Export sessions
          </Button>
          <Button variant="outline" size="sm" className="text-xs">
            <Settings className="h-3 w-3 mr-1" />
            Edit columns
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      className="rounded border-gray-400 text-orange-600 checked:bg-orange-600 checked:border-orange-600 focus:ring-orange-500 focus:ring-2 focus:ring-offset-2"
                      checked={selectAll}
                      onChange={handleSelectAll}
                    />
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  ID
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Items
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Total
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Expires
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">

                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    <div className="flex items-center justify-center space-x-2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-orange-600"></div>
                      <span>Loading checkout sessions...</span>
                    </div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-red-600">
                    <div className="flex items-center justify-center space-x-2">
                      <AlertCircle className="h-4 w-4" />
                      <span>{error}</span>
                    </div>
                  </td>
                </tr>
              ) : checkouts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    <ShoppingCart className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No checkout sessions found.</p>
                  </td>
                </tr>
              ) : (
                checkouts.map((co) => {
                  const url = checkoutUrl(co.id);
                  const itemCount = Array.isArray(co.line_items) ? co.line_items.length : 0;
                  return (
                    <tr key={co.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center">
                          <input
                            type="checkbox"
                            className="rounded border-gray-400 text-orange-600 checked:bg-orange-600 checked:border-orange-600 focus:ring-orange-500 focus:ring-2 focus:ring-offset-2"
                            checked={selectedItems.has(co.id)}
                            onChange={() => handleSelectItem(co.id)}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 bg-orange-100 rounded flex items-center justify-center">
                            <ShoppingCart className="h-4 w-4 text-orange-600" />
                          </div>
                          <span className="text-sm font-medium text-gray-900 font-mono">
                            {co.id.slice(0, 8)}…
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-900">
                          {itemCount} item{itemCount !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-900 font-medium">
                          ${Number(co.total_amount).toFixed(2)} {co.currency}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={STATUS_STYLES[co.status as CheckoutStatus] ?? ''}>
                          {co.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-900">
                          {formatDateTime(co.expires_at)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-900">
                          {formatDate(co.created_at)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <a href={url} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-gray-600">
                            <ExternalLink className="h-4 w-4" />
                          </a>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button className="text-gray-400 hover:text-gray-600 bg-transparent border-none shadow-none">
                                <MoreVertical className="h-4 w-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => copyToClipboard(url)}
                                className="cursor-pointer"
                              >
                                <Copy className="h-4 w-4 mr-2" />
                                Copy checkout link
                              </DropdownMenuItem>
                              {co.status === 'pending' && (
                                <DropdownMenuItem
                                  onClick={() => expireCheckout(co.id)}
                                  className="cursor-pointer text-red-600 focus:text-red-600"
                                >
                                  <AlertCircle className="h-4 w-4 mr-2" />
                                  Expire Session
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer info (Pagination) */}
      <div className="flex items-center justify-between text-sm text-gray-600">
        <div>
          {loading ? 'Loading...' : `Showing ${checkouts.length} of ${total} result${total !== 1 ? 's' : ''}`}
        </div>
        {total > LIMIT && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(o => o - LIMIT)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={offset + LIMIT >= total} onClick={() => setOffset(o => o + LIMIT)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
