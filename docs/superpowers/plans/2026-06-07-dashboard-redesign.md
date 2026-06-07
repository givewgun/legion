# Legion Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Legion web dashboard with a cohesive "Calm Light" design system, client-side routing, a scannable home, a debate view with a convergence chart + full-rationale conversation thread, and an animated "How it works" explainer — no backend changes.

**Architecture:** Add a small design-system layer (`web/src/ui/`) + an agent-identity map, switch `App` to `react-router-dom`, then rebuild each page on those shared primitives. All views derive from existing API endpoints. Charts use recharts, animation uses framer-motion, icons use lucide-react.

**Tech Stack:** React 18, Vite, Tailwind 3, react-router-dom, framer-motion, recharts, lucide-react, Vitest + @testing-library/react.

---

## Conventions for every task

- All commands run from `web/` unless stated otherwise.
- Run a single test file: `npx vitest run test/<path>`. Run all web tests: `npx vitest run`.
- After a task's tests pass, also run `npx vitest run` (web) to confirm no regressions, then from repo root run `npx vitest run` to confirm backend still green (this redesign touches no backend, so it must stay green).
- Format touched files before commit: `npx prettier --write <files>` (from repo root, or `cd ..` first).
- Commit messages use Conventional Commits. Do **not** use `--no-verify`.
- **Tailwind dynamic-class rule:** Tailwind only keeps class names that appear as complete literal strings in source. Never build class names by interpolation (`` `text-${c}` ``). Store **complete** class strings in data maps, and use inline `style` only for values Tailwind can't express (chart hex colors, bar widths).

---

## Task 1: Foundation — dependencies, theme, agent map, format helpers

**Files:**
- Modify: `web/package.json` (dependencies)
- Modify: `web/tailwind.config.js`
- Create: `web/src/lib/agents.js`
- Modify: `web/src/lib/format.js`
- Create: `web/test/lib/agents.test.js`
- Modify: `web/test/lib/format.test.js`

- [ ] **Step 1: Install dependencies**

From `web/`:
```bash
npm install react-router-dom framer-motion recharts lucide-react
```
Expected: the four packages appear under `dependencies` in `web/package.json` and `package-lock.json` updates.

- [ ] **Step 2: Extend the Tailwind theme**

Replace `web/tailwind.config.js` with:
```js
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#4f46e5',
          600: '#4338ca',
          700: '#3730a3',
        },
      },
      boxShadow: {
        card: '0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04)',
        cardhover: '0 4px 12px rgba(15, 23, 42, 0.10)',
      },
      borderRadius: { xl: '0.875rem' },
    },
  },
  plugins: [],
};
```

- [ ] **Step 3: Write the failing test for the agent map**

Create `web/test/lib/agents.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { agentInfo, AGENTS } from '../../src/lib/agents.js';

describe('agent identity map', () => {
  it('returns label, hex color, icon and class strings for known agents', () => {
    const tech = agentInfo('technical');
    expect(tech.label).toBe('Technical');
    expect(tech.hex).toMatch(/^#/);
    expect(typeof tech.Icon).toBe('function'); // lucide icon component
    expect(tech.classes.text).toContain('text-');
    expect(tech.classes.bg).toContain('bg-');
  });

  it('covers all four core agents', () => {
    expect(Object.keys(AGENTS).sort()).toEqual(
      ['contrarian', 'news', 'social', 'technical'].sort(),
    );
  });

  it('falls back gracefully for an unknown agent id', () => {
    const x = agentInfo('mystery');
    expect(x.label).toBe('mystery');
    expect(x.hex).toMatch(/^#/);
    expect(typeof x.Icon).toBe('function');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/lib/agents.test.js`
Expected: FAIL — cannot resolve `../../src/lib/agents.js`.

- [ ] **Step 5: Implement the agent map**

Create `web/src/lib/agents.js`:
```js
import { LineChart, Newspaper, Users, Zap, Bot } from 'lucide-react';

// agent_id -> identity. `hex` is for chart/SVG colors; `classes` hold COMPLETE
// Tailwind class strings (never interpolate class names — Tailwind would purge them).
export const AGENTS = {
  technical: {
    label: 'Technical',
    Icon: LineChart,
    hex: '#d97706',
    classes: { text: 'text-amber-700', bg: 'bg-amber-100', ring: 'ring-amber-200' },
  },
  news: {
    label: 'News',
    Icon: Newspaper,
    hex: '#2563eb',
    classes: { text: 'text-blue-700', bg: 'bg-blue-100', ring: 'ring-blue-200' },
  },
  social: {
    label: 'Social',
    Icon: Users,
    hex: '#7c3aed',
    classes: { text: 'text-violet-700', bg: 'bg-violet-100', ring: 'ring-violet-200' },
  },
  contrarian: {
    label: 'Contrarian',
    Icon: Zap,
    hex: '#16a34a',
    classes: { text: 'text-green-700', bg: 'bg-green-100', ring: 'ring-green-200' },
  },
};

const FALLBACK = {
  Icon: Bot,
  hex: '#64748b',
  classes: { text: 'text-slate-600', bg: 'bg-slate-100', ring: 'ring-slate-200' },
};

export function agentInfo(agentId) {
  const found = AGENTS[agentId];
  if (found) return found;
  return { label: agentId, ...FALLBACK };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/lib/agents.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Write failing tests for new format helpers**

Add to `web/test/lib/format.test.js` (append inside the existing `describe('format helpers', ...)` block, before its closing `});`):
```js
  it('renders a compact relative age with timeAgo', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 30 * 1000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 5 * 60 * 1000).toISOString(), now)).toBe('5m');
    expect(timeAgo(new Date(now - 3 * 3600 * 1000).toISOString(), now)).toBe('3h');
    expect(timeAgo(new Date(now - 2 * 86400 * 1000).toISOString(), now)).toBe('2d');
    expect(timeAgo(null, now)).toBe('');
  });

  it('formats a signed stance delta', () => {
    expect(signedDelta(2)).toBe('+2');
    expect(signedDelta(-1)).toBe('-1');
    expect(signedDelta(0)).toBe('0');
  });
```
And update the import line at the top of the file to:
```js
import { pct, stanceLabel, bandColor, fmtDate, timeAgo, signedDelta } from '../../src/lib/format.js';
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run test/lib/format.test.js`
Expected: FAIL — `timeAgo`/`signedDelta` are not exported.

- [ ] **Step 9: Implement the helpers**

Append to `web/src/lib/format.js`:
```js
// Compact relative age, e.g. "just now", "5m", "3h", "2d". `now` is injectable
// for tests. Returns '' for nullish input.
export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Signed integer for stance moves between rounds, e.g. +2 / -1 / 0.
export function signedDelta(n) {
  return n > 0 ? `+${n}` : String(n);
}
```

- [ ] **Step 10: Run format tests to verify they pass**

Run: `npx vitest run test/lib/format.test.js`
Expected: PASS.

- [ ] **Step 11: Commit**

From repo root:
```bash
npx prettier --write web/package.json web/tailwind.config.js web/src/lib/agents.js web/src/lib/format.js web/test/lib/agents.test.js web/test/lib/format.test.js
git add web/package.json web/package-lock.json web/tailwind.config.js web/src/lib web/test/lib
git commit -m "feat(web): add design-system foundation — deps, theme, agent map, format helpers"
```

---

## Task 2: UI primitives

**Files:**
- Create: `web/src/ui/Card.jsx`
- Create: `web/src/ui/Badge.jsx`
- Create: `web/src/ui/StatTile.jsx`
- Create: `web/src/ui/ConvictionBar.jsx`
- Create: `web/src/ui/AgentAvatar.jsx`
- Create: `web/src/ui/PageHeader.jsx`
- Create: `web/test/ui/primitives.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `web/test/ui/primitives.test.jsx`:
```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from '../../src/ui/Card.jsx';
import { Badge } from '../../src/ui/Badge.jsx';
import { StatTile } from '../../src/ui/StatTile.jsx';
import { ConvictionBar } from '../../src/ui/ConvictionBar.jsx';
import { AgentAvatar } from '../../src/ui/AgentAvatar.jsx';
import { PageHeader } from '../../src/ui/PageHeader.jsx';

describe('ui primitives', () => {
  it('Card renders children', () => {
    render(<Card>hello</Card>);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('Badge colors a BUY band green and a SELL band red', () => {
    const { rerender } = render(<Badge band="STRONG_BUY" />);
    expect(screen.getByText('STRONG_BUY').className).toMatch(/green/);
    rerender(<Badge band="SELL" />);
    expect(screen.getByText('SELL').className).toMatch(/red/);
  });

  it('StatTile shows a label and value', () => {
    render(<StatTile label="Signals" value="12" />);
    expect(screen.getByText('Signals')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('ConvictionBar sets a width from the 0..1 value', () => {
    render(<ConvictionBar value={0.82} band="BUY" />);
    const fill = screen.getByTestId('conviction-fill');
    expect(fill.style.width).toBe('82%');
  });

  it('AgentAvatar labels by agent and renders an icon', () => {
    render(<AgentAvatar agentId="technical" />);
    expect(screen.getByLabelText('Technical')).toBeInTheDocument();
  });

  it('PageHeader renders a title and subtitle', () => {
    render(<PageHeader title="Backtest" subtitle="vs SPY/QQQ" />);
    expect(screen.getByRole('heading', { name: 'Backtest' })).toBeInTheDocument();
    expect(screen.getByText('vs SPY/QQQ')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/ui/primitives.test.jsx`
Expected: FAIL — modules under `src/ui/` not found.

- [ ] **Step 3: Implement the primitives**

Create `web/src/ui/Card.jsx`:
```jsx
export function Card({ className = '', children, ...rest }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white shadow-card ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
```

Create `web/src/ui/Badge.jsx`:
```jsx
// Complete class strings per band so Tailwind keeps them.
const BAND_CLASSES = {
  STRONG_BUY: 'bg-green-100 text-green-700',
  BUY: 'bg-green-100 text-green-700',
  HOLD: 'bg-slate-100 text-slate-600',
  SELL: 'bg-red-100 text-red-700',
  STRONG_SELL: 'bg-red-100 text-red-700',
};

export function Badge({ band, children, className = '' }) {
  const cls = BAND_CLASSES[band] ?? BAND_CLASSES.HOLD;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls} ${className}`}
    >
      {children ?? band}
    </span>
  );
}
```

Create `web/src/ui/StatTile.jsx`:
```jsx
import { Card } from './Card.jsx';

export function StatTile({ label, value, hint }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-xl font-bold text-slate-900">{value}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </Card>
  );
}
```

Create `web/src/ui/ConvictionBar.jsx`:
```jsx
const FILL = {
  STRONG_BUY: 'bg-green-600',
  BUY: 'bg-green-600',
  HOLD: 'bg-slate-400',
  SELL: 'bg-red-600',
  STRONG_SELL: 'bg-red-600',
};

export function ConvictionBar({ value, band = 'HOLD' }) {
  const widthPct = `${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%`;
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-200">
      <div
        data-testid="conviction-fill"
        className={`h-1.5 rounded-full ${FILL[band] ?? FILL.HOLD}`}
        style={{ width: widthPct }}
      />
    </div>
  );
}
```

Create `web/src/ui/AgentAvatar.jsx`:
```jsx
import { agentInfo } from '../lib/agents.js';

// size: 'sm' | 'md'
export function AgentAvatar({ agentId, size = 'md' }) {
  const { label, Icon, classes } = agentInfo(agentId);
  const dim = size === 'sm' ? 'h-6 w-6' : 'h-8 w-8';
  const px = size === 'sm' ? 12 : 16;
  return (
    <span
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${dim} ${classes.bg} ${classes.text}`}
    >
      <Icon size={px} aria-hidden="true" />
    </span>
  );
}
```

Create `web/src/ui/PageHeader.jsx`:
```jsx
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/ui/primitives.test.jsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

From repo root:
```bash
npx prettier --write web/src/ui web/test/ui/primitives.test.jsx
git add web/src/ui web/test/ui
git commit -m "feat(web): add design-system primitives (Card, Badge, StatTile, ConvictionBar, AgentAvatar, PageHeader)"
```

---

## Task 3: App shell + client-side routing

**Files:**
- Modify: `web/src/App.jsx` (full rewrite)
- Create: `web/src/ui/NavBar.jsx`
- Modify: `web/test/pages/` — none removed here; add `web/test/App.test.jsx`
- Note: `web/src/main.jsx` already renders `<App />` and needs no change (router lives inside App).

- [ ] **Step 1: Write the failing test**

Create `web/test/App.test.jsx`:
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from '../src/App.jsx';
import { api } from '../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
  // Every page does a fetch on mount; stub them so routing tests stay isolated.
  vi.spyOn(api, 'listSignals').mockResolvedValue([]);
  vi.spyOn(api, 'listCycleTickers').mockResolvedValue([]);
  vi.spyOn(api, 'getReliability').mockResolvedValue([]);
  vi.spyOn(api, 'getBacktest').mockResolvedValue([]);
  vi.spyOn(api, 'listTickers').mockResolvedValue([]);
});

describe('App shell + routing', () => {
  it('renders the nav and the Signals page at /', async () => {
    render(<App />);
    expect(screen.getByRole('link', { name: /Signals/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Learn/i })).toBeInTheDocument();
    await waitFor(() => expect(api.listSignals).toHaveBeenCalled());
  });

  it('navigates to the Learn page when its nav link is clicked', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('link', { name: /Learn/i }));
    expect(await screen.findByRole('heading', { name: /How Legion works/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/App.test.jsx`
Expected: FAIL — App is not a router yet / no Learn link / no "How Legion works" heading.

- [ ] **Step 3: Implement the NavBar**

Create `web/src/ui/NavBar.jsx`:
```jsx
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
```

- [ ] **Step 4: Rewrite App as the router shell**

Replace `web/src/App.jsx` with:
```jsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { NavBar } from './ui/NavBar.jsx';
import { SignalFeed } from './pages/SignalFeed.jsx';
import { DebateViewer } from './pages/DebateViewer.jsx';
import { TickerConfig } from './pages/TickerConfig.jsx';
import { ReliabilityBoard } from './pages/ReliabilityBoard.jsx';
import { BacktestPage } from './pages/BacktestPage.jsx';
import { LearnPage } from './pages/LearnPage.jsx';

export function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <NavBar />
        <main className="mx-auto max-w-5xl px-6 py-6">
          <Routes>
            <Route path="/" element={<SignalFeed />} />
            <Route path="/debate" element={<DebateViewer />} />
            <Route path="/debate/:symbol" element={<DebateViewer />} />
            <Route path="/debate/:symbol/:cycleId" element={<DebateViewer />} />
            <Route path="/learn" element={<LearnPage />} />
            <Route path="/reliability" element={<ReliabilityBoard />} />
            <Route path="/backtest" element={<BacktestPage />} />
            <Route path="/config" element={<TickerConfig />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
```

- [ ] **Step 5: Add a minimal LearnPage stub so the route resolves**

Create `web/src/pages/LearnPage.jsx` (Task 6 fills this out):
```jsx
import { PageHeader } from '../ui/PageHeader.jsx';

export function LearnPage() {
  return <PageHeader title="How Legion works" subtitle="Consensus, backtesting, and self-learning" />;
}
```

- [ ] **Step 6: Run the App test to verify it passes**

Run: `npx vitest run test/App.test.jsx`
Expected: PASS. Note: existing page tests still render pages directly (not through the router) and remain valid. If any page test newly uses `useNavigate`/`useParams`, it must wrap the page in `<MemoryRouter>` — addressed in the page tasks below.

- [ ] **Step 7: Run all web tests**

Run: `npx vitest run`
Expected: PASS. If `DebateViewer.test.jsx` fails because the component now reads router params, wrap its renders in `<MemoryRouter>` — but defer that to Task 5, which rewrites DebateViewer. For now, if DebateViewer still has its Task-merged signature (no params), it passes unchanged.

- [ ] **Step 8: Commit**

From repo root:
```bash
npx prettier --write web/src/App.jsx web/src/ui/NavBar.jsx web/src/pages/LearnPage.jsx web/test/App.test.jsx
git add web/src/App.jsx web/src/ui/NavBar.jsx web/src/pages/LearnPage.jsx web/test/App.test.jsx
git commit -m "feat(web): add client-side routing and redesigned nav shell"
```

---

## Task 4: Home / Signals — summary strip + sortable table

**Files:**
- Create: `web/src/lib/signals.js` (pure summary + sort helpers)
- Modify: `web/src/pages/SignalFeed.jsx` (full rewrite)
- Create: `web/test/lib/signals.test.js`
- Modify: `web/test/pages/SignalFeed.test.jsx`

- [ ] **Step 1: Write the failing test for summary/sort helpers**

Create `web/test/lib/signals.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { summarize, sortSignals } from '../../src/lib/signals.js';

const rows = [
  { id: 1, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.8, created_at: '2026-06-03T10:00:00Z' },
  { id: 2, symbol: 'TSLA', band: 'SELL', conviction: 0.5, created_at: '2026-06-03T11:00:00Z' },
  { id: 3, symbol: 'MSFT', band: 'HOLD', conviction: 0.2, created_at: '2026-06-03T12:00:00Z' },
];

describe('signal helpers', () => {
  it('summarizes counts, bull/bear split and average conviction', () => {
    const s = summarize(rows);
    expect(s.total).toBe(3);
    expect(s.bull).toBe(1); // STRONG_BUY/BUY
    expect(s.bear).toBe(1); // SELL/STRONG_SELL
    expect(s.avgConviction).toBeCloseTo(0.5, 5);
    expect(s.lastCreatedAt).toBe('2026-06-03T12:00:00Z');
  });

  it('summarizes empty input safely', () => {
    expect(summarize([])).toEqual({
      total: 0,
      bull: 0,
      bear: 0,
      avgConviction: 0,
      lastCreatedAt: null,
    });
  });

  it('sorts by a column ascending and descending', () => {
    expect(sortSignals(rows, 'conviction', 'desc').map((r) => r.id)).toEqual([1, 2, 3]);
    expect(sortSignals(rows, 'conviction', 'asc').map((r) => r.id)).toEqual([3, 2, 1]);
    expect(sortSignals(rows, 'symbol', 'asc').map((r) => r.symbol)).toEqual(['MSFT', 'NVDA', 'TSLA']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lib/signals.test.js`
Expected: FAIL — `src/lib/signals.js` not found.

- [ ] **Step 3: Implement the helpers**

Create `web/src/lib/signals.js`:
```js
const BULL = new Set(['BUY', 'STRONG_BUY']);
const BEAR = new Set(['SELL', 'STRONG_SELL']);

export function summarize(rows) {
  if (!rows || rows.length === 0) {
    return { total: 0, bull: 0, bear: 0, avgConviction: 0, lastCreatedAt: null };
  }
  let bull = 0;
  let bear = 0;
  let convSum = 0;
  let last = null;
  for (const r of rows) {
    if (BULL.has(r.band)) bull += 1;
    if (BEAR.has(r.band)) bear += 1;
    convSum += r.conviction ?? 0;
    if (!last || (r.created_at && r.created_at > last)) last = r.created_at ?? last;
  }
  return {
    total: rows.length,
    bull,
    bear,
    avgConviction: convSum / rows.length,
    lastCreatedAt: last,
  };
}

// Returns a new sorted array. dir is 'asc' | 'desc'. Strings compare
// case-insensitively; everything else compares numerically.
export function sortSignals(rows, key, dir = 'desc') {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * factor;
    }
    return ((av ?? 0) - (bv ?? 0)) * factor;
  });
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `npx vitest run test/lib/signals.test.js`
Expected: PASS.

- [ ] **Step 5: Rewrite the SignalFeed test**

Replace `web/test/pages/SignalFeed.test.jsx` with:
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SignalFeed } from '../../src/pages/SignalFeed.jsx';
import { api } from '../../src/api/client.js';

const ROWS = [
  { id: 1, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.82, created_at: '2026-06-03T10:00:00Z' },
  { id: 2, symbol: 'TSLA', band: 'SELL', conviction: 0.55, created_at: '2026-06-03T12:00:00Z' },
];

function renderAt(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <SignalFeed />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SignalFeed', () => {
  it('shows a summary strip and a row per signal', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue(ROWS);
    renderAt();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('TSLA')).toBeInTheDocument();
    // summary tiles (use the heading for the page title to avoid matching the tile label too)
    expect(screen.getByRole('heading', { name: 'Signals' })).toBeInTheDocument();
    expect(screen.getByText('Bull / Bear')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // total tile value
  });

  it('renders an empty state when there are no signals', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue([]);
    renderAt();
    await waitFor(() => expect(screen.getByText(/No signals yet/i)).toBeInTheDocument());
  });

  it('re-sorts when a column header is clicked', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue(ROWS);
    renderAt();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Ticker/i }));
    const cells = screen.getAllByTestId('row-symbol').map((el) => el.textContent);
    expect(cells).toEqual(['NVDA', 'TSLA']); // ascending by symbol
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/pages/SignalFeed.test.jsx`
Expected: FAIL — current SignalFeed has no summary tiles, no sortable headers, no `row-symbol` testids, no router usage.

- [ ] **Step 7: Rewrite SignalFeed**

Replace `web/src/pages/SignalFeed.jsx` with:
```jsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { pct, timeAgo } from '../lib/format.js';
import { summarize, sortSignals } from '../lib/signals.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { StatTile } from '../ui/StatTile.jsx';
import { Card } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { ConvictionBar } from '../ui/ConvictionBar.jsx';

const COLUMNS = [
  { key: 'symbol', label: 'Ticker' },
  { key: 'band', label: 'Band' },
  { key: 'conviction', label: 'Conviction' },
  { key: 'created_at', label: 'Age' },
];

export function SignalFeed() {
  const [signals, setSignals] = useState([]);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listSignals()
      .then(setSignals)
      .catch((e) => setError(e.message));
  }, []);

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  if (error) return <p className="text-red-600">{error}</p>;

  const summary = summarize(signals);
  const rows = sortSignals(signals, sort.key, sort.dir);

  return (
    <div>
      <PageHeader title="Signals" subtitle="Latest consensus calls across your tickers" />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Signals" value={String(summary.total)} />
        <StatTile label="Bull / Bear" value={`${summary.bull} / ${summary.bear}`} />
        <StatTile label="Avg conviction" value={pct(summary.avgConviction)} />
        <StatTile label="Last run" value={summary.lastCreatedAt ? timeAgo(summary.lastCreatedAt) : '—'} />
      </div>

      {signals.length === 0 ? (
        <p className="text-slate-400">No signals yet.</p>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                {COLUMNS.map((c) => (
                  <th key={c.key} className="px-4 py-2 font-medium text-slate-500">
                    <button
                      className="inline-flex items-center gap-1 hover:text-slate-700"
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      {sort.key === c.key && <span>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.id}
                  className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  onClick={() => navigate(`/debate/${s.symbol}`)}
                >
                  <td className="px-4 py-3 font-semibold text-slate-900" data-testid="row-symbol">
                    {s.symbol}
                  </td>
                  <td className="px-4 py-3">
                    <Badge band={s.band} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ConvictionBar value={s.conviction} band={s.band} />
                      <span className="w-10 shrink-0 text-right text-xs text-slate-500">
                        {pct(s.conviction)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{timeAgo(s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run SignalFeed tests to verify they pass**

Run: `npx vitest run test/pages/SignalFeed.test.jsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Run all web tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

From repo root:
```bash
npx prettier --write web/src/lib/signals.js web/src/pages/SignalFeed.jsx web/test/lib/signals.test.js web/test/pages/SignalFeed.test.jsx
git add web/src/lib/signals.js web/src/pages/SignalFeed.jsx web/test/lib/signals.test.js web/test/pages/SignalFeed.test.jsx
git commit -m "feat(web): redesign home with summary tiles and a sortable signal table"
```

---

## Task 5: Debate — stance-flow chart + conversation thread

**Files:**
- Create: `web/src/lib/debate.js` (pure: stance series + per-round peer/delta derivation)
- Create: `web/src/components/StanceFlowChart.jsx`
- Create: `web/src/components/DebateThread.jsx`
- Modify: `web/src/pages/DebateViewer.jsx` (rewrite detail panel + route params)
- Delete: `web/src/components/RoundCard.jsx`, `web/src/components/VoteRow.jsx` (replaced by thread)
- Delete: `web/test/components/RoundCard.test.jsx` (RoundCard removed)
- Create: `web/test/lib/debate.test.js`
- Create: `web/test/components/DebateThread.test.jsx`
- Modify: `web/test/pages/DebateViewer.test.jsx`

Note: `InfoTip` (`web/src/components/InfoTip.jsx`) stays — reused by the thread metric labels and the Learn page.

- [ ] **Step 1: Write the failing test for debate derivation**

Create `web/test/lib/debate.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { stanceSeries, threadModel } from '../../src/lib/debate.js';

const rounds = [
  {
    round_no: 1,
    s_score: 0.0,
    dispersion: 1.0,
    quorum: 0.5,
    converged: false,
    votes: [
      { agent_id: 'technical', stance: -1, conviction: 0.6, weight: 1, rationale: 'downtrend' },
      { agent_id: 'contrarian', stance: 1, conviction: 0.8, weight: 1, rationale: 'oversold' },
    ],
  },
  {
    round_no: 2,
    s_score: 1.0,
    dispersion: 0.0,
    quorum: 1.0,
    converged: true,
    votes: [
      { agent_id: 'technical', stance: 1, conviction: 0.7, weight: 1, rationale: 'support held' },
      { agent_id: 'contrarian', stance: 1, conviction: 0.9, weight: 1, rationale: 'still oversold' },
    ],
  },
];

describe('debate derivation', () => {
  it('pivots votes into one stance series per agent across rounds', () => {
    const series = stanceSeries(rounds);
    expect(series.agents).toEqual(['contrarian', 'technical']); // sorted
    expect(series.data).toEqual([
      { round: 1, technical: -1, contrarian: 1 },
      { round: 2, technical: 1, contrarian: 1 },
    ]);
  });

  it('builds a thread model with per-round deltas and prior-round peers', () => {
    const model = threadModel(rounds);
    expect(model[0].roundNo).toBe(1);
    // round 1 has no prior round: no delta, no peers
    expect(model[0].messages[0].delta).toBeNull();
    expect(model[0].messages[0].peers).toEqual([]);
    // round 2 technical moved -1 -> 1 (delta +2) and saw contrarian last round
    const tech2 = model[1].messages.find((m) => m.agentId === 'technical');
    expect(tech2.delta).toBe(2);
    expect(tech2.peers).toContain('contrarian');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lib/debate.test.js`
Expected: FAIL — `src/lib/debate.js` not found.

- [ ] **Step 3: Implement debate derivation**

Create `web/src/lib/debate.js`:
```js
// Pivots rounds -> a recharts-friendly series: one numeric key per agent.
export function stanceSeries(rounds = []) {
  const agentSet = new Set();
  for (const r of rounds) for (const v of r.votes ?? []) agentSet.add(v.agent_id);
  const agents = [...agentSet].sort();
  const data = rounds.map((r) => {
    const point = { round: r.round_no };
    for (const v of r.votes ?? []) point[v.agent_id] = v.stance;
    return point;
  });
  return { agents, data };
}

// Builds a per-round thread. Each message carries the agent's vote plus, for
// round >= 2, the stance delta vs that agent's previous round and the list of
// peers it saw (the prior round's other agents — what the engine feeds it).
export function threadModel(rounds = []) {
  return rounds.map((r, i) => {
    const prior = i > 0 ? rounds[i - 1] : null;
    const priorByAgent = new Map((prior?.votes ?? []).map((v) => [v.agent_id, v]));
    const messages = (r.votes ?? []).map((v) => {
      const prev = priorByAgent.get(v.agent_id);
      const delta = prev ? v.stance - prev.stance : null;
      const peers = prior
        ? (prior.votes ?? []).map((p) => p.agent_id).filter((id) => id !== v.agent_id)
        : [];
      return {
        agentId: v.agent_id,
        stance: v.stance,
        conviction: v.conviction,
        rationale: v.rationale,
        delta,
        peers,
      };
    });
    return {
      roundNo: r.round_no,
      sScore: r.s_score,
      dispersion: r.dispersion,
      quorum: r.quorum,
      converged: r.converged,
      messages,
    };
  });
}
```

- [ ] **Step 4: Run debate-lib tests to verify they pass**

Run: `npx vitest run test/lib/debate.test.js`
Expected: PASS.

- [ ] **Step 5: Implement the StanceFlowChart**

Create `web/src/components/StanceFlowChart.jsx`:
```jsx
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
} from 'recharts';
import { agentInfo } from '../lib/agents.js';
import { stanceSeries } from '../lib/debate.js';

const STANCE_TICKS = [-2, -1, 0, 1, 2];

export function StanceFlowChart({ rounds, consensusS }) {
  const { agents, data } = stanceSeries(rounds);
  if (data.length === 0) return null;
  return (
    <div className="h-56 w-full" data-testid="stance-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
          <XAxis
            dataKey="round"
            tickFormatter={(r) => `R${r}`}
            stroke="#94a3b8"
            fontSize={12}
          />
          <YAxis domain={[-2, 2]} ticks={STANCE_TICKS} stroke="#94a3b8" fontSize={12} />
          <Tooltip />
          {typeof consensusS === 'number' && (
            <ReferenceLine y={consensusS} stroke="#4f46e5" strokeDasharray="4 4" />
          )}
          <Legend />
          {agents.map((id) => (
            <Line
              key={id}
              type="monotone"
              dataKey={id}
              name={agentInfo(id).label}
              stroke={agentInfo(id).hex}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 6: Write the failing test for DebateThread**

Create `web/test/components/DebateThread.test.jsx`:
```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebateThread } from '../../src/components/DebateThread.jsx';

const rounds = [
  {
    round_no: 1,
    s_score: 0,
    dispersion: 1,
    quorum: 0.5,
    converged: false,
    votes: [
      {
        agent_id: 'technical',
        stance: -1,
        conviction: 0.6,
        weight: 1,
        rationale: 'A very long rationale that must be shown in full without being truncated anywhere',
      },
    ],
  },
  {
    round_no: 2,
    s_score: 1,
    dispersion: 0,
    quorum: 1,
    converged: true,
    votes: [
      { agent_id: 'technical', stance: 1, conviction: 0.7, weight: 1, rationale: 'support held' },
    ],
  },
];

describe('DebateThread', () => {
  it('renders full rationale text (not truncated)', () => {
    render(<DebateThread rounds={rounds} />);
    expect(
      screen.getByText(/long rationale that must be shown in full without being truncated/i),
    ).toBeInTheDocument();
  });

  it('shows a stance delta for round 2', () => {
    render(<DebateThread rounds={rounds} />);
    expect(screen.getByText('+2')).toBeInTheDocument(); // -1 -> 1
  });

  it('shows the round metrics', () => {
    render(<DebateThread rounds={rounds} />);
    expect(screen.getByText(/Round 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Round 2/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run test/components/DebateThread.test.jsx`
Expected: FAIL — `DebateThread` not found.

- [ ] **Step 8: Implement DebateThread**

Create `web/src/components/DebateThread.jsx`:
```jsx
import { agentInfo } from '../lib/agents.js';
import { AgentAvatar } from '../ui/AgentAvatar.jsx';
import { Badge } from '../ui/Badge.jsx';
import { InfoTip } from './InfoTip.jsx';
import { pct, stanceLabel, signedDelta } from '../lib/format.js';
import { threadModel } from '../lib/debate.js';

function DeltaPill({ delta }) {
  if (!delta) return null; // null or 0 -> no movement worth showing
  const up = delta > 0;
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
        up ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
      }`}
    >
      {up ? '▲' : '▼'} <span>{signedDelta(delta)}</span>
    </span>
  );
}

function Message({ msg }) {
  const { label } = agentInfo(msg.agentId);
  return (
    <div className="flex gap-3">
      <AgentAvatar agentId={msg.agentId} />
      <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm border border-slate-200 bg-slate-50 p-3">
        {msg.peers.length > 0 && (
          <div className="mb-1 border-l-2 border-slate-300 pl-2 text-xs text-slate-400">
            re: {msg.peers.join(', ')}
          </div>
        )}
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-900">{label}</span>
          <Badge band={stanceLabel(msg.stance)}>{stanceLabel(msg.stance)}</Badge>
          <span className="text-xs text-slate-500">conv {pct(msg.conviction)}</span>
          <DeltaPill delta={msg.delta} />
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{msg.rationale}</p>
      </div>
    </div>
  );
}

export function DebateThread({ rounds }) {
  const model = threadModel(rounds);
  return (
    <div className="space-y-6">
      {model.map((round) => (
        <div key={round.roundNo}>
          <div className="mb-3 flex items-center gap-3">
            <span className="text-sm font-semibold text-slate-700">Round {round.roundNo}</span>
            <span className={round.converged ? 'text-xs text-green-600' : 'text-xs text-amber-600'}>
              {round.converged ? 'converged' : 'unconverged'}
            </span>
            <span className="ml-auto flex items-center gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center">
                S {Number(round.sScore).toFixed(2)}
                <InfoTip label="S (aggregate stance)" title="S — aggregate stance">
                  Conviction-weighted mean stance, Σ(W·c·s) / Σ(W·c).
                </InfoTip>
              </span>
              <span className="inline-flex items-center">
                V {Number(round.dispersion).toFixed(2)}
                <InfoTip label="V (dispersion)" title="V — dispersion">
                  Weighted variance of stances around S. Lower means agents agree.
                </InfoTip>
              </span>
              <span className="inline-flex items-center">
                κ {Number(round.quorum).toFixed(2)}
                <InfoTip label="κ (quorum)" title="κ — directional quorum">
                  Weighted fraction of votes agreeing with the aggregate side.
                </InfoTip>
              </span>
            </span>
          </div>
          <div className="space-y-3">
            {round.messages.map((m) => (
              <Message key={m.agentId} msg={m} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Run DebateThread tests to verify they pass**

Run: `npx vitest run test/components/DebateThread.test.jsx`
Expected: PASS (3 tests).

- [ ] **Step 10: Delete the obsolete RoundCard/VoteRow components and the RoundCard test**

```bash
git rm web/src/components/RoundCard.jsx web/src/components/VoteRow.jsx web/test/components/RoundCard.test.jsx
```
(There is no separate VoteRow test file.)

- [ ] **Step 11: Rewrite the DebateViewer test for routing + new detail**

Replace `web/test/pages/DebateViewer.test.jsx` with:
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { DebateViewer } from '../../src/pages/DebateViewer.jsx';
import { api } from '../../src/api/client.js';

const TICKERS = [
  { symbol: 'NVDA', latest_cycle_id: 2, latest_status: 'converged', latest_started_at: '2026-06-03T14:30:00Z', cycle_count: 2 },
  { symbol: 'AAPL', latest_cycle_id: 5, latest_status: 'open', latest_started_at: '2026-06-02T10:00:00Z', cycle_count: 1 },
];
const NVDA_CYCLES = [
  { id: 2, symbol: 'NVDA', status: 'converged', started_at: '2026-06-03T14:30:00Z', ended_at: null },
];
const DEBATE = {
  id: 2,
  symbol: 'NVDA',
  status: 'converged',
  started_at: '2026-06-03T14:30:00Z',
  ended_at: '2026-06-03T14:45:00Z',
  rounds: [
    {
      round_no: 1,
      s_score: 1.0,
      dispersion: 0.0,
      quorum: 1.0,
      converged: true,
      votes: [
        { agent_id: 'contrarian', stance: 1, conviction: 0.8, weight: 1, rationale: 'fear is overdone and the crowd capitulated' },
      ],
    },
  ],
};

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/debate" element={<DebateViewer />} />
        <Route path="/debate/:symbol" element={<DebateViewer />} />
        <Route path="/debate/:symbol/:cycleId" element={<DebateViewer />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'listCycleTickers').mockResolvedValue(TICKERS);
  vi.spyOn(api, 'listCycles').mockResolvedValue(NVDA_CYCLES);
  vi.spyOn(api, 'getDebate').mockResolvedValue(DEBATE);
});

describe('DebateViewer', () => {
  it('lists tickers and prompts to pick one at /debate', async () => {
    renderAt('/debate');
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText(/Pick a ticker/i)).toBeInTheDocument();
    expect(screen.getByLabelText('search-ticker')).toHaveValue('');
  });

  it('filters the ticker list via search', async () => {
    renderAt('/debate');
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('search-ticker'), { target: { value: 'nv' } });
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });

  it('deep-links a cycle and renders the thread with full rationale', async () => {
    renderAt('/debate/NVDA/2');
    await waitFor(() => expect(api.getDebate).toHaveBeenCalledWith(2));
    expect(await screen.findByText(/fear is overdone and the crowd capitulated/i)).toBeInTheDocument();
    expect(screen.getByText(/Round 1/i)).toBeInTheDocument();
    expect(screen.getByTestId('stance-chart')).toBeInTheDocument();
  });
});
```

- [ ] **Step 12: Run it to verify it fails**

Run: `npx vitest run test/pages/DebateViewer.test.jsx`
Expected: FAIL — DebateViewer doesn't use route params / chart / thread yet.

- [ ] **Step 13: Rewrite DebateViewer**

Replace `web/src/pages/DebateViewer.jsx` with:
```jsx
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { fmtDate } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { StanceFlowChart } from '../components/StanceFlowChart.jsx';
import { DebateThread } from '../components/DebateThread.jsx';
import { ConsensusGuide } from '../components/ConsensusGuide.jsx';

function StatusBadge({ status }) {
  const band = status === 'converged' ? 'BUY' : 'HOLD';
  return <Badge band={band}>{status}</Badge>;
}

export function DebateViewer() {
  const { symbol, cycleId } = useParams();
  const navigate = useNavigate();
  const [tickers, setTickers] = useState([]);
  const [query, setQuery] = useState('');
  const [cycles, setCycles] = useState([]);
  const [debate, setDebate] = useState(null);

  useEffect(() => {
    api
      .listCycleTickers()
      .then(setTickers)
      .catch(() => setTickers([]));
  }, []);

  // Load a ticker's cycles whenever the :symbol route param changes.
  useEffect(() => {
    if (!symbol) {
      setCycles([]);
      return;
    }
    api
      .listCycles(symbol)
      .then(setCycles)
      .catch(() => setCycles([]));
  }, [symbol]);

  // Load the selected cycle whenever :cycleId changes.
  useEffect(() => {
    if (!cycleId) {
      setDebate(null);
      return;
    }
    api
      .getDebate(Number(cycleId))
      .then(setDebate)
      .catch(() => setDebate(null));
  }, [cycleId]);

  const filtered = tickers.filter((t) =>
    t.symbol.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const consensusS = debate?.rounds?.length
    ? Number(debate.rounds[debate.rounds.length - 1].s_score)
    : undefined;

  return (
    <div>
      <PageHeader title="Debate" subtitle="How the agents argued their way to consensus" />
      <ConsensusGuide />

      <input
        aria-label="search-ticker"
        className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search ticker…"
      />

      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-64">
          <h2 className="mb-2 text-sm font-semibold text-slate-500">Tickers with debates</h2>
          {tickers.length === 0 && <p className="text-sm text-slate-400">No debate data yet.</p>}
          {tickers.length > 0 && filtered.length === 0 && (
            <p className="text-sm text-slate-400">No ticker matches “{query}”.</p>
          )}
          <ul className="space-y-1">
            {filtered.map((t) => {
              const active = t.symbol === symbol;
              return (
                <li key={t.symbol}>
                  <button
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm ${
                      active ? 'bg-slate-100' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => navigate(`/debate/${t.symbol}`)}
                  >
                    <span className="font-medium">{t.symbol}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">{fmtDate(t.latest_started_at)}</span>
                      <StatusBadge status={t.latest_status} />
                    </span>
                  </button>
                  {active && (
                    <ul className="mb-1 ml-2 border-l border-slate-200 pl-2">
                      {cycles.length === 0 && (
                        <li className="py-1 text-xs text-slate-400">No cycles.</li>
                      )}
                      {cycles.map((c) => (
                        <li key={c.id}>
                          <button
                            className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs ${
                              String(c.id) === String(cycleId)
                                ? 'bg-brand-500 text-white'
                                : 'text-slate-600 hover:bg-slate-100'
                            }`}
                            onClick={() => navigate(`/debate/${t.symbol}/${c.id}`)}
                          >
                            <span>#{c.id}</span>
                            <span className={String(c.id) === String(cycleId) ? 'text-brand-100' : 'text-slate-400'}>
                              {fmtDate(c.started_at)} · {c.status}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="min-w-0 flex-1">
          {debate ? (
            <>
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-lg font-semibold">
                  {debate.symbol} — cycle #{debate.id}
                </h2>
                <StatusBadge status={debate.status} />
              </div>
              <p className="mb-4 text-xs text-slate-400">
                Started {fmtDate(debate.started_at)}
                {debate.ended_at && <> · ended {fmtDate(debate.ended_at)}</>}
              </p>
              <Card className="mb-6 p-3">
                <StanceFlowChart rounds={debate.rounds} consensusS={consensusS} />
              </Card>
              <DebateThread rounds={debate.rounds} />
            </>
          ) : (
            <p className="text-slate-400">
              {symbol ? 'Pick a cycle to see the debate.' : 'Pick a ticker to see its debates.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 14: Run DebateViewer tests to verify they pass**

Run: `npx vitest run test/pages/DebateViewer.test.jsx`
Expected: PASS (3 tests). recharts renders inside jsdom without throwing; the test only asserts the `stance-chart` wrapper exists, not chart geometry.

- [ ] **Step 15: Run all web tests**

Run: `npx vitest run`
Expected: PASS. Confirm no test still imports `RoundCard`/`VoteRow`.

- [ ] **Step 16: Commit**

From repo root:
```bash
npx prettier --write web/src/lib/debate.js web/src/components/StanceFlowChart.jsx web/src/components/DebateThread.jsx web/src/pages/DebateViewer.jsx web/test/lib/debate.test.js web/test/components/DebateThread.test.jsx web/test/pages/DebateViewer.test.jsx
git add -A web/src web/test
git commit -m "feat(web): rebuild debate view with stance-flow chart and conversation thread"
```

---

## Task 6: Learn / How it works page

**Files:**
- Create: `web/src/components/ConsensusPipeline.jsx` (animated hero diagram)
- Create: `web/src/components/LearnSection.jsx` (scroll-reveal section wrapper)
- Modify: `web/src/pages/LearnPage.jsx` (full content)
- Create: `web/test/pages/LearnPage.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `web/test/pages/LearnPage.test.jsx`:
```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LearnPage } from '../../src/pages/LearnPage.jsx';

describe('LearnPage', () => {
  it('renders the title and the pipeline diagram', () => {
    render(<LearnPage />);
    expect(screen.getByRole('heading', { name: /How Legion works/i })).toBeInTheDocument();
    expect(screen.getByTestId('consensus-pipeline')).toBeInTheDocument();
  });

  it('explains all four stages', () => {
    render(<LearnPage />);
    // Use headings so a stage word appearing in the pipeline blurb doesn't cause a double match.
    expect(screen.getByRole('heading', { name: /The debate/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Convergence/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Backtesting/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Self-learning/i })).toBeInTheDocument();
  });

  it('states the convergence rule', () => {
    render(<LearnPage />);
    expect(screen.getByText(/κ ≥ quorum/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/pages/LearnPage.test.jsx`
Expected: FAIL — LearnPage is still the stub (no pipeline testid, no stage text).

- [ ] **Step 3: Implement the animated pipeline**

Create `web/src/components/ConsensusPipeline.jsx`:
```jsx
import { useState } from 'react';
import { motion } from 'framer-motion';

// Nodes positioned on a 320x140 viewBox. The pulse animates along PULSE_PATH,
// looping data -> agents -> consensus -> signal -> outcome -> reliability -> agents.
const NODES = [
  { id: 'data', label: 'Market data', x: 16, y: 56, w: 56, fill: '#f1f5f9', stroke: '#cbd5e1', text: '#475569',
    blurb: 'Price, indicators, sentiment, and news are gathered for the ticker.' },
  { id: 'agents', label: 'Agents', x: 92, y: 56, w: 56, fill: '#dcfce7', stroke: '#16a34a', text: '#166534',
    blurb: 'Four agents (technical, news, social, contrarian) each vote a stance with a conviction.' },
  { id: 'consensus', label: 'Consensus', x: 168, y: 56, w: 64, fill: '#dbeafe', stroke: '#2563eb', text: '#1e40af',
    blurb: 'Votes are weighted and scored (S, V, κ). Agents re-debate until the round converges.' },
  { id: 'signal', label: 'Signal', x: 252, y: 56, w: 52, fill: '#ede9fe', stroke: '#7c3aed', text: '#5b21b6',
    blurb: 'The converged stance becomes a BUY / HOLD / SELL signal with a conviction.' },
  { id: 'outcome', label: 'Outcome', x: 252, y: 104, w: 52, fill: '#fee2e2', stroke: '#dc2626', text: '#991b1b',
    blurb: 'After the horizon, the signal is scored against the actual forward return vs SPY/QQQ.' },
  { id: 'reliability', label: 'Reliability ρ', x: 92, y: 104, w: 76, fill: '#fef3c7', stroke: '#d97706', text: '#92400e',
    blurb: 'Each agent’s hit rate updates its reliability ρ, which re-weights its future votes.' },
];

const PULSE_PATH =
  'M44,72 L120,72 L200,72 L278,72 L278,104 L168,118 L120,90';

export function ConsensusPipeline() {
  const [active, setActive] = useState(null);
  const info = NODES.find((n) => n.id === active);
  return (
    <div data-testid="consensus-pipeline">
      <svg width="100%" viewBox="0 0 320 140" role="img" aria-label="Legion processing pipeline">
        {/* connectors */}
        <g stroke="#cbd5e1" fill="none" strokeWidth="1.5">
          <line x1="72" y1="72" x2="92" y2="72" />
          <line x1="148" y1="72" x2="168" y2="72" />
          <line x1="232" y1="72" x2="252" y2="72" />
          <line x1="278" y1="84" x2="278" y2="104" />
          <line x1="252" y1="116" x2="168" y2="118" />
          <line x1="120" y1="104" x2="120" y2="84" strokeDasharray="3 3" />
        </g>
        {NODES.map((n) => (
          <g key={n.id} onMouseEnter={() => setActive(n.id)} onMouseLeave={() => setActive(null)} style={{ cursor: 'pointer' }}>
            <rect x={n.x} y={n.y} width={n.w} height="24" rx="6" fill={n.fill} stroke={n.stroke} />
            <text x={n.x + n.w / 2} y={n.y + 15} fontSize="9" textAnchor="middle" fill={n.text}>
              {n.label}
            </text>
          </g>
        ))}
        <motion.circle
          r="4"
          fill="#4f46e5"
          animate={{ offsetDistance: ['0%', '100%'] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'linear' }}
          style={{ offsetPath: `path('${PULSE_PATH}')` }}
        />
      </svg>
      <p className="mt-2 min-h-[2.5rem] text-sm text-slate-600">
        {info ? <><span className="font-semibold text-slate-800">{info.label}:</span> {info.blurb}</> : 'Hover a stage to see what it does. The pulse shows the self-learning loop: outcomes update each agent’s reliability, which re-weights the next debate.'}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Implement the scroll-reveal section wrapper**

Create `web/src/components/LearnSection.jsx`:
```jsx
import { motion } from 'framer-motion';
import { Card } from '../ui/Card.jsx';

export function LearnSection({ index, title, children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.4 }}
    >
      <Card className="mb-4 p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
            {index}
          </span>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        </div>
        <div className="text-sm leading-relaxed text-slate-600">{children}</div>
      </Card>
    </motion.div>
  );
}
```

- [ ] **Step 5: Implement the LearnPage content**

Replace `web/src/pages/LearnPage.jsx` with:
```jsx
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';
import { ConsensusPipeline } from '../components/ConsensusPipeline.jsx';
import { LearnSection } from '../components/LearnSection.jsx';

export function LearnPage() {
  return (
    <div>
      <PageHeader
        title="How Legion works"
        subtitle="Consensus debate, backtesting, and self-learning — end to end"
      />

      <Card className="mb-8 p-5">
        <ConsensusPipeline />
      </Card>

      <LearnSection index={1} title="The debate">
        <p>
          For each ticker, Legion runs a cycle with four specialist agents — <strong>technical</strong>,{' '}
          <strong>news</strong>, <strong>social</strong>, and <strong>contrarian</strong>. Every round,
          each agent casts a <em>stance</em> from −2 (strong sell) to +2 (strong buy) with a{' '}
          <em>conviction</em> (0–1). From round two onward, each agent is shown the other agents’
          prior votes and may revise its own.
        </p>
      </LearnSection>

      <LearnSection index={2} title="Convergence (S, V, κ)">
        <p>Each round is scored with three numbers:</p>
        <ul className="ml-4 mt-1 list-disc space-y-1">
          <li><strong>S</strong> — conviction-weighted mean stance, Σ(W·c·s) / Σ(W·c). Drives the BUY/HOLD/SELL band.</li>
          <li><strong>V</strong> — weighted dispersion of stances around S. Lower means the agents agree.</li>
          <li><strong>κ</strong> — weighted fraction of votes whose side agrees with the aggregate.</li>
        </ul>
        <p className="mt-2 rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700">
          A round converges iff κ ≥ quorum AND V ≤ θ_v.
        </p>
      </LearnSection>

      <LearnSection index={3} title="Backtesting">
        <p>
          Converged signals are replayed against history. Legion measures the <strong>hit rate</strong>{' '}
          (how often the call was right over the horizon) and <strong>PnL</strong>, always compared to
          holding <strong>SPY</strong> and <strong>QQQ</strong> over the same window — so a signal has to
          beat the benchmark, not just go up.
        </p>
      </LearnSection>

      <LearnSection index={4} title="Self-learning">
        <p>
          When a signal resolves, each agent’s past vote is scored against the real outcome. That
          updates the agent’s <strong>reliability ρ</strong>, which re-weights how much its vote counts
          in future debates. Agents that are consistently right gain influence; the loop closes and the
          system improves over time.
        </p>
      </LearnSection>
    </div>
  );
}
```

- [ ] **Step 6: Run LearnPage tests to verify they pass**

Run: `npx vitest run test/pages/LearnPage.test.jsx`
Expected: PASS (3 tests). framer-motion renders its children synchronously in jsdom, so `whileInView` content is present.

- [ ] **Step 7: Run all web tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

From repo root:
```bash
npx prettier --write web/src/components/ConsensusPipeline.jsx web/src/components/LearnSection.jsx web/src/pages/LearnPage.jsx web/test/pages/LearnPage.test.jsx
git add web/src/components/ConsensusPipeline.jsx web/src/components/LearnSection.jsx web/src/pages/LearnPage.jsx web/test/pages/LearnPage.test.jsx
git commit -m "feat(web): add animated How-it-works explainer page"
```

---

## Task 7: Reliability + Backtest charts + Config refit

**Files:**
- Modify: `web/src/pages/ReliabilityBoard.jsx`
- Modify: `web/src/pages/BacktestPage.jsx`
- Modify: `web/src/pages/TickerConfig.jsx`
- Modify: `web/test/pages/ReliabilityBoard.test.jsx`
- Modify: `web/test/pages/BacktestPage.test.jsx`
- Modify: `web/test/pages/TickerConfig.test.jsx` (only if the router/import changes break it)

- [ ] **Step 1: Update the ReliabilityBoard test**

Replace `web/test/pages/ReliabilityBoard.test.jsx` with:
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReliabilityBoard } from '../../src/pages/ReliabilityBoard.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

describe('ReliabilityBoard', () => {
  it('renders a bar chart wrapper and the exact-numbers table', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([
      { agentId: 'technical', rho: 0.62, sampleSize: 40 },
      { agentId: 'news', rho: 0.55, sampleSize: 30 },
    ]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('technical')).toBeInTheDocument());
    expect(screen.getByTestId('reliability-chart')).toBeInTheDocument();
    expect(screen.getByText('0.62')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText(/No reliability data yet/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/pages/ReliabilityBoard.test.jsx`
Expected: FAIL — no `reliability-chart` testid yet.

- [ ] **Step 3: Rewrite ReliabilityBoard**

Replace `web/src/pages/ReliabilityBoard.jsx` with:
```jsx
import { useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { api } from '../api/client.js';
import { agentInfo } from '../lib/agents.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

export function ReliabilityBoard() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getReliability()
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (rows && rows.length === 0) return <p className="text-slate-400">No reliability data yet.</p>;

  const data = (rows ?? []).map((r) => ({ ...r, label: agentInfo(r.agentId).label }));

  return (
    <div>
      <PageHeader title="Agent reliability" subtitle="How often each agent has been right (ρ)" />
      <Card className="mb-5 p-3">
        <div className="h-56 w-full" data-testid="reliability-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 24, right: 16 }}>
              <XAxis type="number" domain={[0, 1]} stroke="#94a3b8" fontSize={12} />
              <YAxis type="category" dataKey="label" stroke="#94a3b8" fontSize={12} width={80} />
              <Tooltip />
              <Bar dataKey="rho" radius={[0, 4, 4, 0]}>
                {data.map((r) => (
                  <Cell key={r.agentId} fill={agentInfo(r.agentId).hex} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-medium text-slate-500">Agent</th>
              <th className="px-4 py-2 font-medium text-slate-500">ρ</th>
              <th className="px-4 py-2 font-medium text-slate-500">Sample</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.agentId} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{r.agentId}</td>
                <td className="px-4 py-2">{r.rho.toFixed(2)}</td>
                <td className="px-4 py-2 text-slate-500">{r.sampleSize}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run ReliabilityBoard tests to verify they pass**

Run: `npx vitest run test/pages/ReliabilityBoard.test.jsx`
Expected: PASS.

- [ ] **Step 5: Update the BacktestPage test**

Replace `web/test/pages/BacktestPage.test.jsx` with:
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BacktestPage } from '../../src/pages/BacktestPage.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

describe('BacktestPage', () => {
  it('renders a chart wrapper and the table', async () => {
    vi.spyOn(api, 'getBacktest').mockResolvedValue([
      { id: 1, symbol: 'NVDA', horizon: 5, trades: 10, hit_rate: 0.6, pnl: 0.08, spy_pnl: 0.03, qqq_pnl: 0.04 },
    ]);
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByTestId('backtest-chart')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    vi.spyOn(api, 'getBacktest').mockResolvedValue([]);
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText(/No backtest results yet/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/pages/BacktestPage.test.jsx`
Expected: FAIL — no `backtest-chart` testid yet.

- [ ] **Step 7: Rewrite BacktestPage**

Replace `web/src/pages/BacktestPage.jsx` with:
```jsx
import { useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { api } from '../api/client.js';
import { pct } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

export function BacktestPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getBacktest()
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (rows && rows.length === 0) return <p className="text-slate-400">No backtest results yet.</p>;

  const data = (rows ?? []).map((r) => ({
    symbol: r.symbol,
    Strategy: r.pnl,
    SPY: r.spy_pnl,
    QQQ: r.qqq_pnl,
  }));

  return (
    <div>
      <PageHeader title="Backtest" subtitle="Strategy PnL vs SPY / QQQ benchmarks" />
      <Card className="mb-5 p-3">
        <div className="h-64 w-full" data-testid="backtest-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ left: -8, right: 8 }}>
              <XAxis dataKey="symbol" stroke="#94a3b8" fontSize={12} />
              <YAxis tickFormatter={(v) => pct(v)} stroke="#94a3b8" fontSize={12} />
              <Tooltip formatter={(v) => pct(v)} />
              <Legend />
              <Bar dataKey="Strategy" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              <Bar dataKey="SPY" fill="#94a3b8" radius={[4, 4, 0, 0]} />
              <Bar dataKey="QQQ" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-medium text-slate-500">Symbol</th>
              <th className="px-4 py-2 font-medium text-slate-500">Horizon</th>
              <th className="px-4 py-2 font-medium text-slate-500">Trades</th>
              <th className="px-4 py-2 font-medium text-slate-500">Hit rate</th>
              <th className="px-4 py-2 font-medium text-slate-500">PnL</th>
              <th className="px-4 py-2 font-medium text-slate-500">SPY</th>
              <th className="px-4 py-2 font-medium text-slate-500">QQQ</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{r.symbol}</td>
                <td className="px-4 py-2">{r.horizon}d</td>
                <td className="px-4 py-2">{r.trades}</td>
                <td className="px-4 py-2">{pct(r.hit_rate)}</td>
                <td className="px-4 py-2">{pct(r.pnl)}</td>
                <td className="px-4 py-2 text-slate-500">{pct(r.spy_pnl)}</td>
                <td className="px-4 py-2 text-slate-500">{pct(r.qqq_pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 8: Run BacktestPage tests to verify they pass**

Run: `npx vitest run test/pages/BacktestPage.test.jsx`
Expected: PASS.

- [ ] **Step 9: Refit TickerConfig to the design system**

Replace `web/src/pages/TickerConfig.jsx` with:
```jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

export function TickerConfig() {
  const [tickers, setTickers] = useState([]);
  const [symbol, setSymbol] = useState('');

  function refresh() {
    api
      .listTickers()
      .then(setTickers)
      .catch(() => setTickers([]));
  }
  useEffect(refresh, []);

  async function add(e) {
    e.preventDefault();
    if (!symbol.trim()) return;
    await api.addTicker(symbol.trim());
    setSymbol('');
    refresh();
  }

  async function toggle(t) {
    await api.setTicker(t.symbol, !t.enabled);
    refresh();
  }

  return (
    <div className="max-w-lg">
      <PageHeader title="Ticker config" subtitle="Which symbols Legion evaluates" />
      <form onSubmit={add} className="mb-4 flex gap-2">
        <input
          aria-label="symbol"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="e.g. NVDA"
        />
        <button className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white" type="submit">
          Add
        </button>
      </form>
      <Card className="overflow-hidden">
        <ul>
          {tickers.map((t) => (
            <li
              key={t.symbol}
              className="flex items-center justify-between border-b border-slate-100 px-4 py-2 last:border-0"
            >
              <span className="font-medium">{t.symbol}</span>
              <button
                className={t.enabled ? 'text-sm text-green-600' : 'text-sm text-slate-400'}
                onClick={() => toggle(t)}
              >
                {t.enabled ? 'enabled' : 'disabled'}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
```

- [ ] **Step 10: Run the full web suite**

Run: `npx vitest run`
Expected: PASS. The existing `TickerConfig.test.jsx` asserts on `listTickers`, the `symbol` input, `Add`, and `enabled` toggle — all preserved, so it should pass unchanged. If it fails only because of an import path, fix the import; do not change its assertions.

- [ ] **Step 11: Confirm backend untouched**

From repo root:
```bash
npx vitest run
```
Expected: backend suite still PASS (this redesign changes no backend files).

- [ ] **Step 12: Build check**

From `web/`:
```bash
npm run build
```
Expected: Vite build succeeds (catches any unresolved import / JSX error the tests didn't).

- [ ] **Step 13: Commit**

From repo root:
```bash
npx prettier --write web/src/pages/ReliabilityBoard.jsx web/src/pages/BacktestPage.jsx web/src/pages/TickerConfig.jsx web/test/pages/ReliabilityBoard.test.jsx web/test/pages/BacktestPage.test.jsx
git add web/src/pages web/test/pages
git commit -m "feat(web): add reliability/backtest charts and refit config to the design system"
```

---

## Final verification (after all tasks)

- [ ] From `web/`: `npx vitest run` → all web tests PASS.
- [ ] From repo root: `npx vitest run` → backend tests PASS (unchanged).
- [ ] From `web/`: `npm run build` → succeeds.
- [ ] Manual smoke (optional): `cd web && npm run dev`, click through Signals → row → Debate (chart + thread, full rationale) → Learn (pipeline animates, sections reveal) → Reliability/Backtest (charts) → Config. Confirm no horizontal overflow and the URL changes per page.

## Notes for the executor

- This is a **frontend-only** redesign. Do not modify anything under `src/` (backend) or the API.
- Keep files focused; the structure above already splits pure logic (`src/lib/*`) from presentation (`src/ui/*`, `src/components/*`, `src/pages/*`). Unit-test the pure logic; keep component tests behavioral.
- Tailwind: only complete literal class strings survive purge. Use the data maps in `agents.js`/`Badge`/`ConvictionBar`; use inline `style` only for chart hex + bar widths.
- recharts in jsdom has no layout size; tests assert on wrapper testids + table data, never on rendered chart geometry.
```
