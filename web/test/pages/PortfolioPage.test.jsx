import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PortfolioPage } from '../../src/pages/PortfolioPage.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

const payload = {
  curve: [
    { date: '2026-01-01', equity: 100000, spy: 100000, qqq: 100000 },
    { date: '2026-01-02', equity: 101000, spy: 100500, qqq: 100200 },
  ],
  trades: [
    {
      symbol: 'MSFT',
      band: 'BUY',
      conviction: 0.8,
      entryDate: '2026-01-01',
      entryPrice: 100,
      shares: 80,
      exitDate: '2026-01-02',
      exitPrice: 110,
      return: 0.1,
      exitReason: 'horizon',
    },
  ],
  openPositions: [
    { symbol: 'NVDA', shares: 2, entryPrice: 50, markPrice: 75, unrealizedReturn: 0.5 },
  ],
  stats: {
    totalReturn: 0.05,
    spyReturn: 0.005,
    qqqReturn: 0.002,
    openValue: 150,
    cash: 9850,
    winRate: 1,
    trades: 1,
  },
};

describe('PortfolioPage', () => {
  it('renders stats, the chart, open positions, and the trades table', async () => {
    vi.spyOn(api, 'getPortfolio').mockResolvedValue(payload);
    render(<PortfolioPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByTestId('portfolio-chart')).toBeInTheDocument();
    expect(screen.getByText(/Total return/i)).toBeInTheDocument();
    expect(screen.getByText('horizon')).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00 → \$75\.00/)).toBeInTheDocument();
  });

  it('shows an empty state when there is nothing to simulate', async () => {
    vi.spyOn(api, 'getPortfolio').mockResolvedValue({
      curve: [],
      trades: [],
      openPositions: [],
      stats: {},
    });
    render(<PortfolioPage />);
    await waitFor(() =>
      expect(screen.getByText(/No signals to simulate yet/i)).toBeInTheDocument(),
    );
  });

  it('shows an error state', async () => {
    vi.spyOn(api, 'getPortfolio').mockRejectedValue(new Error('boom'));
    render(<PortfolioPage />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
