import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, Users } from 'lucide-react';
import { request, errorMessage } from '@/lib/api';
import { formatBytes, formatDate, minorToAmount } from '@/lib/format';
import { Card, EmptyState, PageLoader, Button, Input } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import type { Role } from '@/types/api';

/** Mirrors the payload of `GET /admin/overview`. */
interface AdminOverview {
  counts: {
    users: number;
    photographers: number;
    clients: number;
    bookings: number;
    pendingBookings: number;
    projects: number;
    photos: number;
    inquiries: number;
    newInquiriesThisWeek: number;
  };
  revenue: { last30DaysMinor: number; transactions: number };
  storage: { bytes: number; objects: number };
  generatedAt: string;
}

/** Mirrors one entry of `GET /admin/users`. */
interface AdminUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  role: Role;
  status: 'active' | 'suspended' | 'pending_verification';
  emailVerified: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
}

interface AdminUsersResponse {
  users: AdminUser[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const STATUS_TONE: Record<AdminUser['status'], string> = {
  active: 'text-emerald-300',
  suspended: 'text-rose-300',
  pending_verification: 'text-amber-300',
};

export function AdminPage() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => request<AdminOverview>({ url: '/admin/overview' }),
  });

  const users = useQuery({
    queryKey: ['admin', 'users', { search, roleFilter, statusFilter, page }],
    queryFn: () =>
      request<AdminUsersResponse>({
        url: '/admin/users',
        params: {
          page,
          limit: 25,
          ...(search ? { q: search } : {}),
          ...(roleFilter ? { role: roleFilter } : {}),
          ...(statusFilter ? { status: statusFilter } : {}),
        },
      }),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: 'active' | 'suspended'; reason: string }) =>
      request<{ id: string; status: string }>({
        url: `/admin/users/${id}/status`,
        method: 'PATCH',
        data: { status, reason },
      }),
    onSuccess: (_result, variables) => {
      setNotice(`${variables.status === 'suspended' ? 'Suspended' : 'Restored'} that account.`);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
    onError: (error) => setActionError(errorMessage(error, 'Could not update that account.')),
  });

  /** The server refuses self-suspension, so the control is hidden instead of 400-ing. */
  async function toggleStatus(target: AdminUser) {
    const suspending = target.status !== 'suspended';
    /* The endpoint requires a reason of at least 5 characters for the audit
     * trail. A real UI would prompt; a plain confirm keeps this minimal while
     * still sending a non-empty reason. */
    const reason = suspending
      ? window.prompt(`Reason for suspending ${target.email}? (min 5 characters)`) ?? ''
      : 'Restored from the admin console.';
    if (suspending && reason.trim().length < 5) return;
    setNotice(null);
    setStatus.mutate({ id: target.id, status: suspending ? 'suspended' : 'active', reason });
  }

  if (overview.isPending) return <PageLoader />;
  if (overview.isError) {
    return <EmptyState title="We could not load the platform overview." hint="Try again in a moment." />;
  }

  const data = overview.data;
  const stats = data?.counts;
  const pagination = users.data?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Shield className="size-5 text-ink-400" />
        <h1 className="text-display text-3xl font-semibold tracking-tight">Platform overview</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Users</p>
          <p className="mt-2 text-3xl font-semibold text-white">{stats?.users ?? 0}</p>
          <p className="mt-1 text-xs text-ink-400">
            {stats?.photographers ?? 0} photographers · {stats?.clients ?? 0} clients
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Bookings</p>
          <p className="mt-2 text-3xl font-semibold text-white">{stats?.bookings ?? 0}</p>
          <p className="mt-1 text-xs text-ink-400">{stats?.pendingBookings ?? 0} awaiting review</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Revenue (30d)</p>
          <p className="mt-2 text-3xl font-semibold text-white">
            {minorToAmount(data?.revenue?.last30DaysMinor)}
          </p>
          <p className="mt-1 text-xs text-ink-400">{data?.revenue?.transactions ?? 0} transactions</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Storage</p>
          <p className="mt-2 text-3xl font-semibold text-white">
            {formatBytes(data?.storage?.bytes)}
          </p>
          <p className="mt-1 text-xs text-ink-400">{data?.storage?.objects ?? 0} objects</p>
        </Card>
      </div>

      <Card>
        <p className="text-xs uppercase tracking-wide text-ink-400">Content</p>
        <div className="mt-3 grid gap-3 text-sm text-ink-300 sm:grid-cols-3">
          <span>{stats?.projects ?? 0} projects</span>
          <span>{stats?.photos ?? 0} photos</span>
          <span>
            {stats?.inquiries ?? 0} inquiries ({stats?.newInquiriesThisWeek ?? 0} this week)
          </span>
        </div>
      </Card>

      <div className="flex items-center gap-2">
        <Users className="size-5 text-ink-400" />
        <h2 className="text-display text-xl font-semibold tracking-tight">Users</h2>
      </div>

      <Card className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search name or email"
            aria-label="Search users"
          />
          <select
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by role"
            className="h-10 rounded-xl border border-ink-700 bg-ink-900 px-3 text-sm text-white"
          >
            <option value="">All roles</option>
            <option value="photographer">Photographers</option>
            <option value="client">Clients</option>
            <option value="superadmin">Super admins</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by status"
            className="h-10 rounded-xl border border-ink-700 bg-ink-900 px-3 text-sm text-white"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="pending_verification">Pending verification</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>

        {actionError && <p className="text-sm text-rose-300">{actionError}</p>}
        {notice && <p className="text-sm text-emerald-300">{notice}</p>}

        {users.isPending ? (
          <PageLoader />
        ) : users.isError ? (
          <EmptyState title="We could not load users." hint="Try again in a moment." />
        ) : users.data?.users.length === 0 ? (
          <EmptyState title="No users match those filters." hint="Try a different search." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Email</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Last login</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {users.data?.users.map((u) => (
                  <tr key={u.id} className="border-t border-ink-800">
                    <td className="py-2 pr-3 text-white">{u.name}</td>
                    <td className="py-2 pr-3 text-ink-300">{u.email}</td>
                    <td className="py-2 pr-3 capitalize text-ink-300">{u.role}</td>
                    <td className={`py-2 pr-3 capitalize ${STATUS_TONE[u.status] ?? 'text-ink-300'}`}>
                      {u.status.replace('_', ' ')}
                    </td>
                    <td className="py-2 pr-3 text-ink-300">{formatDate(u.lastLoginAt)}</td>
                    <td className="py-2 text-right">
                      {u.id === me?.id ? (
                        <span className="text-xs text-ink-500">You</span>
                      ) : (
                        <Button
                          size="sm"
                          variant={u.status === 'suspended' ? 'secondary' : 'ghost'}
                          disabled={setStatus.isPending}
                          onClick={() => void toggleStatus(u)}
                        >
                          {u.status === 'suspended' ? 'Restore' : 'Suspend'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-ink-400">
            <span>
              Page {pagination.page} of {pagination.totalPages} · {pagination.total} users
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={pagination.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
