import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button, Card, Input } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { homeFor } from '@/lib/roles';
import { cn } from '@/lib/cn';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' });
  const [role, setRole] = useState<'client' | 'photographer'>('client');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await register({
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
        role,
      });
      navigate(homeFor(user.role), { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-5 py-20">
      <h1 className="text-display text-4xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-2 text-sm text-ink-400">Join as a client to book, or as a photographer to sell.</p>
      <Card className="mt-8 space-y-5">
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-ink-850 p-1">
          {(['client', 'photographer'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setRole(value)}
              className={cn(
                'h-9 rounded-lg text-sm capitalize transition-colors',
                role === value ? 'bg-ink-700 text-white' : 'text-ink-400 hover:text-white',
              )}
            >
              {value}
            </button>
          ))}
        </div>
        <form className="space-y-4" onSubmit={onSubmit}>
          <Input
            id="name"
            label="Full name"
            required
            minLength={2}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
          <Input
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />
          <Input
            id="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            placeholder="10+ characters, upper, lower and a number"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
          />
          <Input
            id="phone"
            label="Phone (optional)"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
          {error && <p className="text-sm text-rose-500">{error}</p>}
          <Button type="submit" className="w-full" loading={loading}>
            Create account
          </Button>
        </form>
        <p className="text-center text-sm text-ink-400">
          Already have an account?{' '}
          <Link to="/login" className="text-amber-400 hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
}
