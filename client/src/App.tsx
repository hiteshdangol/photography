import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { SiteLayout } from '@/components/SiteLayout';
import { AppShell } from '@/components/AppShell';
import { PageLoader } from '@/components/ui';
import type { Role } from '@/types/api';

import { HomePage } from '@/pages/HomePage';
import { DirectoryPage } from '@/pages/DirectoryPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { PackagesPage } from '@/pages/PackagesPage';
import { LoginPage } from '@/pages/LoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { BookingsPage } from '@/pages/BookingsPage';
import { PackagesManagerPage } from '@/pages/PackagesManagerPage';
import { ChatPage } from '@/pages/ChatPage';
import { SectionPlaceholder } from '@/pages/SectionPlaceholder';

function RequireAuth({ roles }: { roles?: Role[] }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader />;
  if (status !== 'authenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={user.role === 'client' ? '/me' : '/dashboard'} replace />;
  }
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/photographers" element={<DirectoryPage />} />
        <Route path="/photographers/:slug" element={<ProfilePage />} />
        <Route path="/packages" element={<PackagesPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route path="/chat" element={<ChatPage />} />
      </Route>

      <Route element={<RequireAuth roles={['photographer']} />}>
        <Route path="/dashboard" element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="packages" element={<PackagesManagerPage />} />
          <Route path="projects" element={<SectionPlaceholder title="Projects" />} />
          <Route path="clients" element={<SectionPlaceholder title="Clients" />} />
          <Route path="portfolio" element={<SectionPlaceholder title="Portfolio" />} />
          <Route path="invoices" element={<SectionPlaceholder title="Invoices" />} />
          <Route path="analytics" element={<SectionPlaceholder title="Analytics" />} />
          <Route path="wallet" element={<SectionPlaceholder title="Wallet" />} />
        </Route>
      </Route>

      <Route element={<RequireAuth roles={['client']} />}>
        <Route path="/me" element={<AppShell />}>
          <Route index element={<SectionPlaceholder title="Your space" />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="galleries" element={<SectionPlaceholder title="Galleries" />} />
          <Route path="favorites" element={<SectionPlaceholder title="Favourites" />} />
          <Route path="billing" element={<SectionPlaceholder title="Billing" />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
