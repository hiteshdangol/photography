import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { SiteLayout } from '@/components/SiteLayout';
import { AppShell } from '@/components/AppShell';
import { PageLoader } from '@/components/ui';
import { homeFor } from '@/lib/roles';
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
import { AdminPage } from '@/pages/AdminPage';
import { ProjectPage } from '@/pages/ProjectPage';
import { SharedGalleryPage } from '@/pages/SharedGalleryPage';
import { FavoritesPage } from '@/pages/FavoritesPage';
import { ProjectsListPage } from '@/pages/ProjectsListPage';
import { ClientGalleriesPage } from '@/pages/ClientGalleriesPage';
import { InvoicesPage } from '@/pages/InvoicesPage';
import { BillingPage } from '@/pages/BillingPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { ClientsPage } from '@/pages/ClientsPage';
import { PortfolioManagerPage } from '@/pages/PortfolioManagerPage';

function RequireAuth({ roles }: { roles?: Role[] }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader />;
  if (status !== 'authenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  /* Send the user to their own home rather than a hardcoded role list: a
   * superadmin used to be redirected to `/dashboard`, which is gated to
   * photographers, so the guard rejected them again and looped. */
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homeFor(user.role)} replace />;
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
        {/*
          A share link has to work for someone with no account, so this sits
          outside RequireAuth and outside the dashboard shell. The server
          authorises it with the token in the URL.
        */}
        <Route path="/g/:token" element={<SharedGalleryPage />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route path="/chat" element={<ChatPage />} />
        {/* Canonical project route, shared by photographers and clients. */}
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/projects/:projectId/:section" element={<ProjectPage />} />
      </Route>

      <Route element={<RequireAuth roles={['photographer']} />}>
        <Route path="/dashboard" element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="packages" element={<PackagesManagerPage />} />
          <Route path="projects" element={<ProjectsListPage />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route path="projects/:projectId/:section" element={<ProjectPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="portfolio" element={<PortfolioManagerPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="wallet" element={<SectionPlaceholder title="Wallet" />} />
        </Route>
      </Route>

      <Route element={<RequireAuth roles={['superadmin']} />}>
        <Route path="/admin" element={<AppShell />}>
          <Route index element={<AdminPage />} />
        </Route>
      </Route>

      <Route element={<RequireAuth roles={['client']} />}>
        <Route path="/me" element={<AppShell />}>
          <Route index element={<SectionPlaceholder title="Your space" />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="galleries" element={<ClientGalleriesPage />} />
          <Route path="favorites" element={<FavoritesPage />} />
          <Route path="billing" element={<BillingPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
