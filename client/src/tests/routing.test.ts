import { describe, expect, it } from 'vitest';
import { homeFor, isRootNavItem } from '@/lib/roles';
import type { Role } from '@/types/api';

/**
 * The superadmin redirect loop.
 *
 * `RequireAuth` used to redirect any role mismatch to
 * `user.role === 'client' ? '/me' : '/dashboard'`. A superadmin fails the
 * `roles={['photographer']}` guard on `/dashboard`, gets redirected back to
 * `/dashboard`, fails the same guard again, forever. Because the mapping was
 * duplicated across four files, fixing one site left the others broken.
 */
describe('homeFor', () => {
  it('routes each role to a page that role can actually access', () => {
    expect(homeFor('client')).toBe('/me');
    expect(homeFor('photographer')).toBe('/dashboard');
    expect(homeFor('superadmin')).toBe('/admin');
  });

  /**
   * The invariant that was violated: a role must never be sent to a route whose
   * guard excludes it, because that is exactly what produces a redirect loop.
   */
  it('never sends a role to a route gated for a different role', () => {
    // Mirrors the guards declared in App.tsx.
    const guards: { path: string; roles: Role[] }[] = [
      { path: '/me', roles: ['client'] },
      { path: '/dashboard', roles: ['photographer'] },
      { path: '/admin', roles: ['superadmin'] },
    ];
    const allRoles: Role[] = ['superadmin', 'photographer', 'client'];

    for (const role of allRoles) {
      const destination = homeFor(role);
      const guard = guards.find((g) => g.path === destination);
      expect(guard, `no route matches homeFor('${role}') = '${destination}'`).toBeDefined();
      expect(
        guard?.roles.includes(role),
        `homeFor('${role}') = '${destination}' but that route only allows ${guard?.roles.join(', ')}`,
      ).toBe(true);
    }
  });

  it('returns a distinct destination per role, so no two roles share a home', () => {
    const homes = (['superadmin', 'photographer', 'client'] as Role[]).map(homeFor);
    expect(new Set(homes).size).toBe(homes.length);
  });
});

describe('isRootNavItem', () => {
  it('matches only the parent routes, so a parent link is not active on its children', () => {
    // Without this, `/dashboard` stays highlighted while viewing
    // `/dashboard/bookings`, because NavLink matches prefixes by default.
    expect(isRootNavItem('/dashboard')).toBe(true);
    expect(isRootNavItem('/me')).toBe(true);
    expect(isRootNavItem('/admin')).toBe(true);

    expect(isRootNavItem('/dashboard/bookings')).toBe(false);
    expect(isRootNavItem('/me/galleries')).toBe(false);
    expect(isRootNavItem('/chat')).toBe(false);
  });
});
