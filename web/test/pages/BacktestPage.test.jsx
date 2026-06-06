import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BacktestPage } from '../../src/pages/BacktestPage.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BacktestPage', () => {
  it('renders backtest rows with hit-rate and pnl', async () => {
    vi.spyOn(api, 'getBacktest').mockResolvedValue([
      {
        id: 1,
        symbol: 'NVDA',
        horizon: 5,
        trades: 12,
        hits: 8,
        hit_rate: 0.667,
        pnl: 0.21,
        spy_pnl: 0.05,
        qqq_pnl: 0.07,
      },
    ]);
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    // pct() rounds to a whole percent: 0.667 -> "67%"
    expect(screen.getByText('67%')).toBeInTheDocument();
  });

  it('shows empty state with no results', async () => {
    vi.spyOn(api, 'getBacktest').mockResolvedValue([]);
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText(/no backtest results/i)).toBeInTheDocument());
  });
});
