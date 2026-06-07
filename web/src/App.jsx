import { useState } from 'react';
import { SignalFeed } from './pages/SignalFeed.jsx';
import { DebateViewer } from './pages/DebateViewer.jsx';
import { TickerConfig } from './pages/TickerConfig.jsx';
import { ReliabilityBoard } from './pages/ReliabilityBoard.jsx';
import { BacktestPage } from './pages/BacktestPage.jsx';
import { AgentConfig } from './pages/AgentConfig.jsx';

const TABS = ['Signals', 'Debate', 'Config', 'Reliability', 'Backtest', 'Agents'];

export function App() {
  const [tab, setTab] = useState('Signals');

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

      {tab === 'Signals' && <SignalFeed />}
      {tab === 'Debate' && <DebateViewer />}
      {tab === 'Config' && <TickerConfig />}
      {tab === 'Reliability' && <ReliabilityBoard />}
      {tab === 'Backtest' && <BacktestPage />}
      {tab === 'Agents' && <AgentConfig />}
    </div>
  );
}
