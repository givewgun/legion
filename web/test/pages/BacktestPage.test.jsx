import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BacktestPage } from '../../src/pages/BacktestPage.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

describe('BacktestPage', () => {
  it('renders a chart wrapper and the table', async () => {
    vi.spyOn(api, 'getBacktest').mockResolvedValue([
      {
        id: 1,
        symbol: 'NVDA',
        horizon: 5,
        trades: 10,
        hit_rate: 0.6,
        pnl: 0.08,
        spy_pnl: 0.03,
        qqq_pnl: 0.04,
      },
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
