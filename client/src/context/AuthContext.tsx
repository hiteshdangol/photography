import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { request, setAccessToken } from '@/lib/api';
import { connectSocket, disconnectSocket } from '@/lib/socket';
import { queryClient } from '@/lib/query';
import type { AuthResponse, MeResponse, Role, SessionUser } from '@/types/api';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
  role: 'photographer' | 'client';
}

interface AuthContextValue {
  user: SessionUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<SessionUser>;
  register: (input: RegisterInput) => Promise<SessionUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const loadUser = useCallback(async (): Promise<SessionUser | null> => {
    const { user: me } = await request<MeResponse>({ url: '/auth/me' });
    return me;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await loadUser();
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
        connectSocket();
      } catch {
        if (cancelled) return;
        setUser(null);
        setStatus('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadUser]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await request<AuthResponse>({
      url: '/auth/login',
      method: 'POST',
      data: { email, password },
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
    setStatus('authenticated');
    connectSocket();
    return data.user;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const data = await request<AuthResponse>({
      url: '/auth/register',
      method: 'POST',
      data: input,
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
    setStatus('authenticated');
    connectSocket();
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await request({ url: '/auth/logout', method: 'POST' });
    } finally {
      setAccessToken(null);
      disconnectSocket();
      setUser(null);
      setStatus('anonymous');
      queryClient.clear();
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await loadUser();
      setUser(me);
      setStatus('authenticated');
    } catch {
      setUser(null);
      setStatus('anonymous');
    }
  }, [loadUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      login,
      register,
      logout,
      refreshUser,
      hasRole: (...roles: Role[]) => (user ? roles.includes(user.role) : false),
    }),
    [user, status, login, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
