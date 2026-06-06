import { useState } from 'react';
import { SignalFeed } from './pages/SignalFeed.jsx';
import { DebateViewer } from './pages/DebateViewer.jsx';
import { TickerConfig } from './pages/TickerConfig.jsx';
import { ReliabilityBoard } from './pages/ReliabilityBoard.jsx';
import { BacktestPage } from './pages/BacktestPage.jsx';

const TABS = ['Signals', 'Debate', 'Config', 'Reliability', 'Backtest'];

export function App() {
  const [tab, setTab] = useState('Signals');
  const [symbol, setSymbol] = useState('NVDA');

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">Legion</h1>
        <nav className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t}
              className={`rounded px-3 py-1 ${tab === t ? 'bg-slate-800 text-white' : 'text-slate-600'}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'Debate' && (
        <input
          aria-label="debate-symbol"
          className="mb-4 rounded border border-slate-300 px-2 py-1"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
      )}

      {tab === 'Signals' && <SignalFeed />}
      {tab === 'Debate' && <DebateViewer symbol={symbol} />}
      {tab === 'Config' && <TickerConfig />}
      {tab === 'Reliability' && <ReliabilityBoard />}
      {tab === 'Backtest' && <BacktestPage />}
    </div>
  );
}
