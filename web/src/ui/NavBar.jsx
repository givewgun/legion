import { NavLink } from 'react-router-dom';

const LINKS = [
  { to: '/', label: 'Signals', end: true },
  { to: '/debate', label: 'Debate' },
  { to: '/learn', label: 'Learn' },
  { to: '/reliability', label: 'Reliability' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/config', label: 'Config' },
];

export function NavBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <span className="text-lg font-bold tracking-tight text-slate-900">Legion</span>
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
      </div>
    </header>
  );
}
