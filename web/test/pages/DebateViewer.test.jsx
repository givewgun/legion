import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DebateViewer } from '../../src/pages/DebateViewer.jsx';
import { api } from '../../src/api/client.js';

const TICKERS = [
  {
    symbol: 'NVDA',
    latest_cycle_id: 2,
    latest_status: 'converged',
    latest_started_at: '2026-06-03T14:30:00Z',
    cycle_count: 2,
  },
  {
    symbol: 'AAPL',
    latest_cycle_id: 5,
    latest_status: 'open',
    latest_started_at: '2026-06-02T10:00:00Z',
    cycle_count: 1,
  },
];

const NVDA_CYCLES = [
  {
    id: 2,
    symbol: 'NVDA',
    status: 'converged',
    started_at: '2026-06-03T14:30:00Z',
    ended_at: null,
  },
];

const DEBATE = {
  id: 2,
  symbol: 'NVDA',
  status: 'converged',
  started_at: '2026-06-03T14:30:00Z',
  ended_at: '2026-06-03T14:45:00Z',
  rounds: [
    {
      round_no: 1,
      s_score: 1.0,
      dispersion: 0.0,
      quorum: 1.0,
      converged: true,
      votes: [
        {
          agent_id: 'contrarian',
          stance: 1,
          conviction: 0.8,
          weight: 1,
          rationale: 'fear is overdone',
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('DebateViewer', () => {
  it('lists tickers that have data without auto-selecting one', async () => {
    vi.spyOn(api, 'listCycleTickers').mockResolvedValue(TICKERS);

    render(<DebateViewer />);

    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    // Nothing pre-selected: the empty state prompts the user to pick a ticker.
    expect(screen.getByText(/Pick a ticker/i)).toBeInTheDocument();
    // Search box is present and is NOT pre-filled with a symbol.
    expect(screen.getByLabelText('search-ticker')).toHaveValue('');
  });

  it('filters the ticker list with the search box', async () => {
    vi.spyOn(api, 'listCycleTickers').mockResolvedValue(TICKERS);

    render(<DebateViewer />);
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('search-ticker'), { target: { value: 'nv' } });
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });

  it('drills ticker → cycle → debate and shows S/V/κ with tooltips', async () => {
    vi.spyOn(api, 'listCycleTickers').mockResolvedValue(TICKERS);
    vi.spyOn(api, 'listCycles').mockResolvedValue(NVDA_CYCLES);
    vi.spyOn(api, 'getDebate').mockResolvedValue(DEBATE);

    render(<DebateViewer />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());

    fireEvent.click(screen.getByText('NVDA'));
    await waitFor(() => expect(api.listCycles).toHaveBeenCalledWith('NVDA'));

    fireEvent.click(await screen.findByText('#2'));
    await waitFor(() => expect(api.getDebate).toHaveBeenCalledWith(2));

    expect(await screen.findByText(/Round 1/i)).toBeInTheDocument();
    expect(screen.getByText('contrarian')).toBeInTheDocument();
    // Metric tooltips are present.
    expect(screen.getByLabelText(/What is S \(aggregate stance\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/What is V \(dispersion\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/What is κ \(quorum\)/i)).toBeInTheDocument();
  });

  it('shows an empty state when no tickers have data', async () => {
    vi.spyOn(api, 'listCycleTickers').mockResolvedValue([]);

    render(<DebateViewer />);
    await waitFor(() => expect(screen.getByText(/No debate data yet/i)).toBeInTheDocument());
  });
});
