import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from '../src/App.jsx';
import { api } from '../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
  // Every page does a fetch on mount; stub them so routing tests stay isolated.
  vi.spyOn(api, 'getMe').mockResolvedValue({ id: 1, email: 'a@b.com', name: 'A' });
  vi.spyOn(api, 'listSignals').mockResolvedValue([]);
  vi.spyOn(api, 'listCycleTickers').mockResolvedValue([]);
  vi.spyOn(api, 'getReliability').mockResolvedValue([]);
  vi.spyOn(api, 'getBacktest').mockResolvedValue([]);
  vi.spyOn(api, 'getPortfolio').mockResolvedValue({
    gateway: { configured: false, authenticated: false, accountId: null },
    stats: { equity: null, cash: null, totalReturn: null, spyReturn: null, qqqReturn: null },
    curve: [],
    positions: [],
    orders: [],
  });
  vi.spyOn(api, 'listTickers').mockResolvedValue([]);
});

describe('App shell + routing', () => {
  it('renders the nav and the Signals page at /', async () => {
    render(<App />);
    // Wait for auth to resolve before nav is visible
    expect(await screen.findByRole('link', { name: /Signals/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Learn/i })).toBeInTheDocument();
    await waitFor(() => expect(api.listSignals).toHaveBeenCalled());
  });

  it('navigates to the Learn page when its nav link is clicked', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: /Learn/i }));
    expect(await screen.findByRole('heading', { name: /How Legion works/i })).toBeInTheDocument();
  });

  it('navigates to the Portfolio page when its nav link is clicked', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: /Portfolio/i }));
    await waitFor(() => expect(api.getPortfolio).toHaveBeenCalled());
    expect(
      await screen.findByText(/No paper trades yet — enable trading in Settings\./i),
    ).toBeInTheDocument();
  });
});
