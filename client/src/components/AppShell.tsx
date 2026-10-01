import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  CalendarDays,
  FolderKanban,
  Images,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Package,
  Receipt,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import { Logo } from './Logo';
import { cn } from '@/lib/cn';
import { useAuth } from '@/context/AuthContext';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const photographerNav: NavItem[] = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { to: '/dashboard/bookings', label: 'Bookings', icon: CalendarDays },
  { to: '/dashboard/projects', label: 'Projects', icon: FolderKanban },
  { to: '/dashboard/clients', label: 'Clients', icon: Users },
  { to: '/dashboard/packages', label: 'Packages', icon: Package },
  { to: '/dashboard/portfolio', label: 'Portfolio', icon: Images },
  { to: '/dashboard/invoices', label: 'Invoices', icon: Receipt },
  { to: '/dashboard/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/dashboard/wallet', label: 'Wallet', icon: Wallet },
];

const clientNav: NavItem[] = [
  { to: '/me', label: 'Overview', icon: LayoutDashboard },
  { to: '/me/bookings', label: 'My bookings', icon: CalendarDays },
  { to: '/me/galleries', label: 'Galleries', icon: Images },
  { to: '/me/favorites', label: 'Favourites', icon: Sparkles },
  { to: '/me/billing', label: 'Billing', icon: Wallet },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const nav = user?.role === 'client' ? clientNav : photographerNav;

  async function handleLogout() {
    await logout();
    navigate('/', { replace: true });
  }

  return (
    <div className="flex min-h-full">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 -translate-x-full border-r border-ink-800 bg-ink-900 p-4 transition-transform lg:translate-x-0',
          mobileOpen && 'translate-x-0',
        )}
      >
        <div className="mb-6 px-2">
          <Logo to={nav[0].to} />
        </div>
        <nav className="flex flex-col gap-1">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/dashboard' || item.to === '/me'}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                  isActive ? 'bg-ink-800 text-white' : 'text-ink-400 hover:bg-ink-850 hover:text-white',
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
          <Link
            to="/chat"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-400 transition-colors hover:bg-ink-850 hover:text-white"
          >
            <MessageSquare className="size-4" />
            Messages
          </Link>
        </nav>
        <button
          onClick={handleLogout}
          className="mt-8 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-400 transition-colors hover:bg-ink-850 hover:text-white"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
      </aside>

      {mobileOpen && (
        <button
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="flex h-16 items-center justify-between border-b border-ink-800 px-5">
          <button
            className="rounded-lg px-2 py-1 text-sm text-ink-300 lg:hidden"
            onClick={() => setMobileOpen((v) => !v)}
          >
            Menu
          </button>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-medium text-white">{user?.name}</p>
              <p className="text-xs capitalize text-ink-400">{user?.role}</p>
            </div>
          </div>
        </header>
        <main className="flex-1 p-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
