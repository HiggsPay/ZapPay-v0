import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { SignIn, SignUp } from '@clerk/clerk-react';
import { DashboardLayout } from '@/components/dashboard/DashboardLayout';
import { Home } from '@/pages/Home';
import { Balance } from '@/pages/Balance';
import { Transactions } from '@/pages/Transactions';
import { Customers } from '@/pages/Customers';
import { Products } from '@/pages/Products';
import { Radar } from '@/pages/Radar';
import { PaymentLinks } from '@/pages/PaymentLinks';
import { Plugins } from '@/pages/Plugins';
import { Reporting } from '@/pages/Reporting';
import { Terminal } from '@/pages/Terminal';
import { Billing } from '@/pages/Billing';
import { ZapPayUI } from '@/pages/ZapPayUI';
import { RequireAuth } from '@/components/RequireAuth';
import { Settings } from '@/pages/Settings';
import { Webhook } from '@/pages/Webhook';
import { Checkouts } from '@/pages/Checkouts';
import { WalletProvider } from '@/contexts/WalletContext';
import './App.css';

function App() {
  return (
    <WalletProvider>
      <Router>
        <Routes>
          {/* Auth routes — Clerk hosted components */}
          <Route
            path="/auth/sign-in/*"
            element={
              <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <SignIn routing="path" path="/auth/sign-in" signUpUrl="/auth/sign-up" />
              </div>
            }
          />
          <Route
            path="/auth/sign-up/*"
            element={
              <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <SignUp routing="path" path="/auth/sign-up" signInUrl="/auth/sign-in" />
              </div>
            }
          />

          {/* Legacy auth redirect */}
          <Route path="/auth" element={
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
              <SignIn routing="path" path="/auth" signUpUrl="/auth/sign-up" />
            </div>
          } />

          {/* Protected dashboard routes */}
          <Route element={<RequireAuth />}>
            <Route path="/" element={<DashboardLayout />}>
              <Route index element={<Home />} />
              <Route path="balance" element={<Balance />} />
              <Route path="transactions" element={<Transactions />} />
              <Route path="customers" element={<Customers />} />
              <Route path="products" element={<Products />} />
              <Route path="payment-links" element={<PaymentLinks />} />
              <Route path="checkouts" element={<Checkouts />} />
              <Route path="plugins" element={<Plugins />} />
              <Route path="radar" element={<Radar />} />
              <Route path="reporting" element={<Reporting />} />
              <Route path="terminal" element={<Terminal />} />
              <Route path="billing" element={<Billing />} />
              <Route path="settings" element={<Settings />} />
              <Route path="webhook" element={<Webhook />} />
            </Route>
          </Route>

          {/* Consumer-facing payment pages — no auth required */}
          <Route path="/payment/:paymentLink" element={<ZapPayUI />} />
          <Route path="/c/:checkoutId" element={<ZapPayUI />} />
          {/* Legacy query-param checkout URL */}
          <Route path="/checkout" element={<ZapPayUI />} />
        </Routes>
      </Router>
    </WalletProvider>
  );
}

export default App;
