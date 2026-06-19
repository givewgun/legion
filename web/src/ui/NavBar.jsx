import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const LINKS = [
  { to: '/', label: 'Signals', end: true },
  { to: '/debate', label: 'Debate' },
  { to: '/learn', label: 'Learn' },
  { to: '/reliability', label: 'Reliability' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/config', label: 'Config' },
  { to: '/agents', label: 'Agents' },
];

export function NavBar() {
  const { user, signOut } = useAuth();

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <span className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900">
          <img src="/legion_gpt.png" alt="Legion" className="h-8 w-8 object-contain" />
          Legion
        </span>
        <nav className="flex flex-wrap gap-1">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `rounded-lg px-3 py-1.5 text-sm font-medium ${
                  isActive ? 'bg-brand-500 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        {user && (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-slate-600">{user.name ?? user.email}</span>
            <button onClick={signOut} className="text-sm text-slate-500 hover:underline">
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
