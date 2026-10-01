import { Link, NavLink, Outlet } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Logo } from './Logo';
import { Button } from './ui';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/cn';
import { homeFor } from '@/lib/roles';

const links = [
  { to: '/photographers', label: 'Photographers' },
  { to: '/packages', label: 'Packages' },
];

export function SiteLayout() {
  const { user, status } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5">
          <Logo />
          <nav className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  cn(
                    'rounded-full px-4 py-2 text-sm transition-colors',
                    isActive ? 'text-white' : 'text-ink-400 hover:text-white',
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="hidden items-center gap-2 md:flex">
            {status === 'authenticated' && user ? (
              <Link
                to={homeFor(user.role)}
                className="inline-flex h-9 items-center rounded-full border border-ink-700 bg-ink-800 px-4 text-sm text-white transition-colors hover:bg-ink-700"
              >
                Dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="rounded-full px-4 py-2 text-sm text-ink-300 hover:text-white">
                  Sign in
                </Link>
                <Link to="/register">
                  <Button size="sm">Get started</Button>
                </Link>
              </>
            )}
          </div>
          <button
            className="grid size-10 place-items-center rounded-xl text-ink-300 md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
        {open && (
          <div className="border-t border-ink-800 px-5 py-4 md:hidden">
            <div className="flex flex-col gap-1">
              {links.map((l) => (
                <Link key={l.to} to={l.to} onClick={() => setOpen(false)} className="py-2 text-ink-300">
                  {l.label}
                </Link>
              ))}
              {status === 'authenticated' ? (
                <Link to={user ? homeFor(user.role) : '/login'} onClick={() => setOpen(false)} className="py-2 text-white">
                  Dashboard
                </Link>
              ) : (
                <Link to="/login" onClick={() => setOpen(false)} className="py-2 text-white">
                  Sign in
                </Link>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-ink-800/80">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-10 text-sm text-ink-400 sm:flex-row sm:items-center sm:justify-between">
          <Logo />
          <p>Capture. Connect. Create memories.</p>
        </div>
      </footer>
    </div>
  );
}
