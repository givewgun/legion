import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WatchlistPage } from '../src/pages/WatchlistPage.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('WatchlistPage', () => {
  it('renders the user watchlist', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({ symbols: ['NVDA'] });
    vi.spyOn(api, 'listTickers').mockResolvedValue([{ symbol: 'NVDA', enabled: true }, { symbol: 'AMD', enabled: true }]);
    render(<WatchlistPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
  });

  it('adds a symbol', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({ symbols: [] });
    vi.spyOn(api, 'listTickers').mockResolvedValue([{ symbol: 'AMD', enabled: true }]);
    const add = vi.spyOn(api, 'addToWatchlist').mockResolvedValue({ symbols: ['AMD'] });
    render(<WatchlistPage />);
    await waitFor(() => expect(screen.getByText(/add/i)).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox'), 'AMD');
    await userEvent.click(screen.getByText(/add/i));
    expect(add).toHaveBeenCalledWith('AMD');
  });
});
