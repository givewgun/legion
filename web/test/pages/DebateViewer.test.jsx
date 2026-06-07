import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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
          rationale: 'fear is overdone and the crowd capitulated',
        },
      ],
    },
  ],
};

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/debate" element={<DebateViewer />} />
        <Route path="/debate/:symbol" element={<DebateViewer />} />
        <Route path="/debate/:symbol/:cycleId" element={<DebateViewer />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'listCycleTickers').mockResolvedValue(TICKERS);
  vi.spyOn(api, 'listCycles').mockResolvedValue(NVDA_CYCLES);
  vi.spyOn(api, 'getDebate').mockResolvedValue(DEBATE);
});

describe('DebateViewer', () => {
  it('lists tickers and prompts to pick one at /debate', async () => {
    renderAt('/debate');
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText(/Pick a ticker/i)).toBeInTheDocument();
    expect(screen.getByLabelText('search-ticker')).toHaveValue('');
  });

  it('filters the ticker list via search', async () => {
    renderAt('/debate');
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('search-ticker'), { target: { value: 'nv' } });
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });

  it('deep-links a cycle and renders the thread with full rationale', async () => {
    renderAt('/debate/NVDA/2');
    await waitFor(() => expect(api.getDebate).toHaveBeenCalledWith(2));
    expect(
      await screen.findByText(/fear is overdone and the crowd capitulated/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Round 1/i)).toBeInTheDocument();
    expect(screen.getByTestId('stance-chart')).toBeInTheDocument();
  });
});
