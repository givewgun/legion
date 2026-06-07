import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SignalFeed } from '../../src/pages/SignalFeed.jsx';
import { api } from '../../src/api/client.js';

const ROWS = [
  {
    id: 1,
    symbol: 'NVDA',
    band: 'STRONG_BUY',
    conviction: 0.82,
    created_at: '2026-06-03T10:00:00Z',
  },
  { id: 2, symbol: 'TSLA', band: 'SELL', conviction: 0.55, created_at: '2026-06-03T12:00:00Z' },
];

function renderAt(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <SignalFeed />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SignalFeed', () => {
  it('shows a summary strip and a row per signal', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue(ROWS);
    renderAt();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('TSLA')).toBeInTheDocument();
    // summary tiles (use the heading for the page title to avoid matching the tile label too)
    expect(screen.getByRole('heading', { name: 'Signals' })).toBeInTheDocument();
    expect(screen.getByText('Bull / Bear')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // total tile value
  });

  it('renders an empty state when there are no signals', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue([]);
    renderAt();
    await waitFor(() => expect(screen.getByText(/No signals yet/i)).toBeInTheDocument());
  });

  it('re-sorts when a column header is clicked', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue(ROWS);
    renderAt();
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Ticker/i }));
    const cells = screen.getAllByTestId('row-symbol').map((el) => el.textContent);
    expect(cells).toEqual(['NVDA', 'TSLA']); // ascending by symbol
  });
});
