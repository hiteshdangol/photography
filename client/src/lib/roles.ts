import type { Role } from '@/types/api';

/**
 * Where a role lands after signing in.
 *
 * This used to be an inline ternary repeated in four places, and they disagreed:
 * the redirect guard, the login page and the mobile header all assumed anything
 * that was not a client was a photographer. A `superadmin` therefore failed the
 * `roles={['photographer']}` guard on `/dashboard`, was redirected back to
 * `/dashboard`, and looped forever. Centralising the mapping here means a new
 * role cannot be added without the redirect following it.
 */
export function homeFor(role: Role): string {
  if (role === 'superadmin') return '/admin';
  return role === 'client' ? '/me' : '/dashboard';
}

/** Routes that match only exactly, so a parent link is not also active on children. */
export function isRootNavItem(to: string): boolean {
  return to === '/dashboard' || to === '/me' || to === '/admin';
}
