import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button, Card, Input } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { homeFor } from '@/lib/roles';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? homeFor(user.role), { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not sign you in.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-5 py-20">
      <h1 className="text-display text-4xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-sm text-ink-400">Sign in to manage your work or your memories.</p>
      <Card className="mt-8 space-y-5">
        <form className="space-y-4" onSubmit={onSubmit}>
          <Input
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-rose-500">{error}</p>}
          <Button type="submit" className="w-full" loading={loading}>
            Sign in
          </Button>
        </form>
        <p className="text-center text-sm text-ink-400">
          New to LensFlow?{' '}
          <Link to="/register" className="text-amber-400 hover:underline">
            Create an account
          </Link>
        </p>
      </Card>
    </div>
  );
}
