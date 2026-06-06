import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SignalFeed } from '../../src/pages/SignalFeed.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SignalFeed', () => {
  it('renders fetched signals', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue([
      { id: 1, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.9, plan: {} },
    ]);
    render(<SignalFeed />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('STRONG_BUY')).toBeInTheDocument();
    expect(screen.getByText('conv 90%')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue([]);
    render(<SignalFeed />);
    await waitFor(() => expect(screen.getByText(/no signals/i)).toBeInTheDocument());
  });
});
