import type {
  Transaction,
  Customer,
  DashboardStats,
  ChartData
} from '@/types';

// Mock Transactions
export const mockTransactions: Transaction[] = [
  {
    id: 'tx-001',
    type: 'payment',
    status: 'completed',
    amount: 299.99,
    currency: 'USD',
    cryptoAmount: 0.0082,
    cryptoCurrency: 'BTC',
    customer: {
      name: 'Sarah Johnson',
      email: 'sarah@example.com'
    },
    timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 mins ago
    txHash: '0x1234...5678',
    gasUsed: '21,000',
    networkFee: 2.50
  },
  {
    id: 'tx-002',
    type: 'payment',
    status: 'pending',
    amount: 149.99,
    currency: 'USD',
    cryptoAmount: 89.2,
    cryptoCurrency: 'USDC',
    customer: {
      name: 'Michael Chen',
      email: 'michael@example.com'
    },
    timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(), // 15 mins ago
    networkFee: 0.75
  },
  {
    id: 'tx-003',
    type: 'payment',
    status: 'completed',
    amount: 89.99,
    currency: 'USD',
    cryptoAmount: 0.0547,
    cryptoCurrency: 'ETH',
    customer: {
      name: 'Emma Wilson',
      email: 'emma@example.com'
    },
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
    txHash: '0xabcd...efgh',
    gasUsed: '42,000',
    networkFee: 4.20
  },
  {
    id: 'tx-004',
    type: 'withdrawal',
    status: 'completed',
    amount: 500.00,
    currency: 'USD',
    cryptoAmount: 500.0,
    cryptoCurrency: 'USDC',
    customer: {
      name: 'System Withdrawal',
      email: 'system@merchant.com'
    },
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
    txHash: '0x9876...5432',
    networkFee: 1.25
  },
  {
    id: 'tx-005',
    type: 'payment',
    status: 'failed',
    amount: 199.99,
    currency: 'USD',
    cryptoAmount: 0.0055,
    cryptoCurrency: 'BTC',
    customer: {
      name: 'Alex Rodriguez',
      email: 'alex@example.com'
    },
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(), // 6 hours ago
    networkFee: 0.00
  }
];

// Mock Customers
export const mockCustomers: Customer[] = [
  {
    id: 'cust-001',
    name: 'Sarah Johnson',
    email: 'sarah@example.com',
    totalSpent: 1299.97,
    totalTransactions: 8,
    lastSeen: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    status: 'active'
  },
  {
    id: 'cust-002',
    name: 'Michael Chen',
    email: 'michael@example.com',
    totalSpent: 849.95,
    totalTransactions: 5,
    lastSeen: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    status: 'active'
  },
  {
    id: 'cust-003',
    name: 'Emma Wilson',
    email: 'emma@example.com',
    totalSpent: 2150.88,
    totalTransactions: 12,
    lastSeen: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    status: 'active'
  },
  {
    id: 'cust-004',
    name: 'Alex Rodriguez',
    email: 'alex@example.com',
    totalSpent: 499.99,
    totalTransactions: 3,
    lastSeen: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    status: 'inactive'
  }
];

// Mock Dashboard Stats
export const mockDashboardStats: DashboardStats = {
  totalRevenue: 24567.89,
  totalTransactions: 1234,
  activeCustomers: 456,
  conversionRate: 3.2,
  revenueChange: 12.5,
  transactionChange: 8.3,
  customerChange: 15.7,
  conversionChange: -2.1
};

// Mock Chart Data (last 30 days)
export const mockChartData: ChartData[] = Array.from({ length: 30 }, (_, i) => {
  const date = new Date(Date.now() - (29 - i) * 24 * 60 * 60 * 1000);
  const baseRevenue = 800 + Math.sin(i / 5) * 200;
  const variance = Math.random() * 0.4 - 0.2; // ±20% variance
  
  return {
    date: date.toISOString().split('T')[0],
    revenue: Math.round(baseRevenue * (1 + variance)),
    transactions: Math.round((baseRevenue / 50) * (1 + variance)),
    customers: Math.round((baseRevenue / 100) * (1 + variance))
  };
});