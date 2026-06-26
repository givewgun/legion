import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HoldingsPage } from '../../src/pages/HoldingsPage.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

describe('HoldingsPage', () => {
  it('renders the sizing table with a recommended action', async () => {
    vi.spyOn(api, 'getHoldings').mockResolvedValue({ holdings: [{ ticker: 'NVDA', shares: 10, avgCost: 80 }] });
    vi.spyOn(api, 'getSizing').mockResolvedValue({
      rows: [{ ticker: 'NVDA', currentWeight: 0.5, targetWeight: 0.075, deltaUSD: -425, action: 'trim', unrealizedPnl: 200, unrealizedPnlPct: 0.25, flags: [] }],
      summary: { totalValue: 1000, totalCost: 800, unrealizedPnl: 200, targetInvestedPct: 0.075 },
    });
    render(<HoldingsPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText(/trim/i)).toBeInTheDocument();
  });
});
