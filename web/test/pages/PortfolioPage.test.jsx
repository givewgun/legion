import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PortfolioPage } from '../../src/pages/PortfolioPage.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

const payload = {
  gateway: { configured: true, authenticated: true, accountId: 'DU1234567' },
  stats: { equity: 105000, cash: 5000, totalReturn: 0.05, spyReturn: 0.02, qqqReturn: 0.03 },
  curve: [
    { date: '2026-01-01', equity: 100000, spy: 100000, qqq: 100000 },
    { date: '2026-01-02', equity: 101000, spy: 100500, qqq: 100200 },
  ],
  positions: [
    {
      symbol: 'NVDA',
      qty: 10,
      avgCost: 50,
      markPrice: 75,
      marketValue: 750,
      unrealizedPnl: 250,
      unrealizedPnlPct: 0.5,
    },
  ],
  orders: [
    {
      id: 1,
      createdAt: '2026-01-02T15:30:00Z',
      symbol: 'MSFT',
      band: 'BUY',
      conviction: 0.8,
      targetWeight: 0.1,
      status: 'filled',
      skipReason: null,
      submittedQty: 20,
      fillQty: 20,
      fillPrice: 410.5,
      error: null,
    },
    {
      id: 2,
      createdAt: '2026-01-02T15:31:00Z',
      symbol: 'TSLA',
      band: 'SELL',
      conviction: 0.6,
      targetWeight: 0,
      status: 'skipped',
      skipReason: 'below min order size',
      submittedQty: null,
      fillQty: null,
      fillPrice: null,
      error: null,
    },
  ],
};

const degradedPayload = {
  gateway: { configured: false, authenticated: false, accountId: null },
  stats: { equity: null, cash: null, totalReturn: null, spyReturn: null, qqqReturn: null },
  curve: [{ date: '2026-01-01', equity: 100000, spy: 100000, qqq: 100000 }],
  positions: [],
  orders: [
    {
      id: 3,
      createdAt: '2026-01-01T10:00:00Z',
      symbol: 'AAPL',
      band: 'BUY',
      conviction: 0.7,
      targetWeight: 0.05,
      status: 'failed',
      skipReason: null,
      submittedQty: null,
      fillQty: null,
      fillPrice: null,
      error: 'gateway not authenticated',
    },
  ],
};

describe('PortfolioPage', () => {
  it('renders the gateway chip, stats, positions, and order log', async () => {
    vi.spyOn(api, 'getPortfolio').mockResolvedValue(payload);
    render(<PortfolioPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());

    expect(screen.getByText('Gateway: DU1234567')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-chart')).toBeInTheDocument();
    expect(screen.getByText(/\$105,000/)).toBeInTheDocument();
    expect(screen.getByText(/\$5,000/)).toBeInTheDocument();
    expect(screen.getByText('+5.00%')).toBeInTheDocument();

    // positions table
    expect(screen.getByText(/\$50\.00 → \$75\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$750/)).toBeInTheDocument();

    // order log
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText(/filled/)).toBeInTheDocument();
    expect(screen.getByText('TSLA')).toBeInTheDocument();
    expect(screen.getByText(/skipped/)).toBeInTheDocument();
    expect(screen.getByText(/below min order size/)).toBeInTheDocument();
  });

  it('renders a null-safe degraded state when the gateway is down', async () => {
    vi.spyOn(api, 'getPortfolio').mockResolvedValue(degradedPayload);
    render(<PortfolioPage />);
    await waitFor(() => expect(screen.getByText('Gateway: not configured')).toBeInTheDocument());

    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText(/failed/)).toBeInTheDocument();
    expect(screen.getByText(/gateway not authenticated/)).toBeInTheDocument();
    // No NaN / undefined should leak into stats when gateway stats are null.
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no snapshots or orders', async () => {
    vi.spyOn(api, 'getPortfolio').mockResolvedValue({
      gateway: { configured: false, authenticated: false, accountId: null },
      stats: { equity: null, cash: null, totalReturn: null, spyReturn: null, qqqReturn: null },
      curve: [],
      positions: [],
      orders: [],
    });
    render(<PortfolioPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/No paper trades yet — enable trading in Settings\./i),
      ).toBeInTheDocument(),
    );
  });

  it('shows an error state', async () => {
    vi.spyOn(api, 'getPortfolio').mockRejectedValue(new Error('boom'));
    render(<PortfolioPage />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
