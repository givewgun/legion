import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { NavBar } from './ui/NavBar.jsx';
import { SignalFeed } from './pages/SignalFeed.jsx';
import { DebateViewer } from './pages/DebateViewer.jsx';
import { TickerConfig } from './pages/TickerConfig.jsx';
import { ReliabilityBoard } from './pages/ReliabilityBoard.jsx';
import { BacktestPage } from './pages/BacktestPage.jsx';
import { PortfolioPage } from './pages/PortfolioPage.jsx';
import { LearnPage } from './pages/LearnPage.jsx';
import { AgentConfig } from './pages/AgentConfig.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import { LoginGate } from './auth/LoginGate.jsx';

export function App() {
  return (
    <AuthProvider>
      <LoginGate>
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
                <Route path="/portfolio" element={<PortfolioPage />} />
                {/* /watchlist route added in B12 */}
                <Route path="/config" element={<TickerConfig />} />
                <Route path="/agents" element={<AgentConfig />} />
              </Routes>
            </main>
          </div>
        </BrowserRouter>
      </LoginGate>
    </AuthProvider>
  );
}
