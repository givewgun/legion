import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TickerConfig } from '../../src/pages/TickerConfig.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TickerConfig', () => {
  it('lists tickers and toggles one', async () => {
    vi.spyOn(api, 'listTickers').mockResolvedValue([{ symbol: 'NVDA', enabled: true }]);
    const setTicker = vi
      .spyOn(api, 'setTicker')
      .mockResolvedValue({ symbol: 'NVDA', enabled: false });

    render(<TickerConfig />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());

    fireEvent.click(screen.getByText('enabled'));
    expect(setTicker).toHaveBeenCalledWith('NVDA', false);
  });

  it('adds a ticker from the form', async () => {
    vi.spyOn(api, 'listTickers').mockResolvedValue([]);
    const addTicker = vi
      .spyOn(api, 'addTicker')
      .mockResolvedValue({ symbol: 'AMD', enabled: true });

    render(<TickerConfig />);
    fireEvent.change(screen.getByLabelText('symbol'), { target: { value: 'amd' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(addTicker).toHaveBeenCalledWith('amd'));
  });
});
