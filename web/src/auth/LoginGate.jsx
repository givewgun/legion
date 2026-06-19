import { useAuth } from './AuthContext.jsx';

export function LoginGate({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">Loading…</div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50">
        <h1 className="text-2xl font-semibold text-slate-800">Legion</h1>
        <p className="text-slate-500">Sign in to view your dashboard.</p>
        <a
          href="/api/auth/google"
          className="rounded-md bg-slate-900 px-5 py-2.5 text-white hover:bg-slate-700"
        >
          Sign in with Google
        </a>
      </div>
    );
  }

  return children;
}
