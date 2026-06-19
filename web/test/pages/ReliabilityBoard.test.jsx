import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReliabilityBoard } from '../../src/pages/ReliabilityBoard.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

const FULL_ROW = {
  agentId: 'technical',
  rho: 1.12,
  calibration: 0.87,
  infoFactor: 1.05,
  learnedPrior: 0.55,
  flagged: false,
  flooredStreak: 0,
  sampleSize: 40,
  wins: 28,
  losses: 7,
  holds: 5,
  hitRate: 0.8,
  avgAlpha: 0.018,
  bestAlpha: 0.091,
  worstAlpha: -0.074,
  recent: [
    { symbol: 'NVDA', stance: 1, conviction: 0.8, win: true, alpha: 0.035 },
    { symbol: 'AAPL', stance: -1, conviction: 0.6, win: false, alpha: -0.02 },
    { symbol: 'MSFT', stance: 0, conviction: 0.5, win: null, alpha: null },
  ],
};

const NULL_METRICS_ROW = {
  agentId: 'news',
  rho: 0.98,
  calibration: 0.71,
  infoFactor: 0.92,
  learnedPrior: 0.5,
  flagged: false,
  flooredStreak: 0,
  sampleSize: 5,
  wins: 0,
  losses: 0,
  holds: 5,
  hitRate: null,
  avgAlpha: null,
  bestAlpha: null,
  worstAlpha: null,
  recent: [],
};

describe('ReliabilityBoard', () => {
  it('renders a bar chart wrapper and the exact-numbers table', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([
      { ...FULL_ROW, agentId: 'technical', rho: 0.62, sampleSize: 40 },
      { ...NULL_METRICS_ROW, agentId: 'news', rho: 0.55, sampleSize: 30 },
    ]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('Technical')).toBeInTheDocument());
    expect(screen.getByTestId('reliability-chart')).toBeInTheDocument();
    expect(screen.getByText('0.62')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText(/No reliability data yet/i)).toBeInTheDocument());
  });

  it('renders all new table columns', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([FULL_ROW]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('Technical')).toBeInTheDocument());

    // Column headers
    expect(screen.getByText('Record')).toBeInTheDocument();
    expect(screen.getByText('Hit%')).toBeInTheDocument();
    expect(screen.getByText('Avg α')).toBeInTheDocument();
    expect(screen.getByText('ρ')).toBeInTheDocument();
    expect(screen.getByText('Calibration')).toBeInTheDocument();
    expect(screen.getByText('Info')).toBeInTheDocument();
    expect(screen.getByText('Sample')).toBeInTheDocument();

    // Data cells: Record W–L–H
    expect(screen.getByText('28–7–5')).toBeInTheDocument();

    // Hit rate rendered as %
    expect(screen.getByText('80.0%')).toBeInTheDocument();

    // ρ and calibration
    expect(screen.getByText('1.12')).toBeInTheDocument();
    expect(screen.getByText('0.87')).toBeInTheDocument();
  });

  it('shows "—" for null metrics', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([NULL_METRICS_ROW]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('News')).toBeInTheDocument());

    // Scope assertions to the specific agent row so we know which cells are "—"
    const row = screen.getByTestId('agent-row-news');
    const cells = row.querySelectorAll('td');
    // td[2] = Hit%, td[3] = Avg α (0-indexed)
    expect(cells[2].textContent).toBe('—');
    expect(cells[3].textContent).toBe('—');
  });

  it('expanding a row reveals recent calls', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([FULL_ROW]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('Technical')).toBeInTheDocument());

    // Recent calls table not visible yet
    expect(screen.queryByTestId('recent-calls-table')).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByTestId('agent-row-technical'));

    // Recent calls table should now appear
    expect(screen.getByTestId('recent-calls-table')).toBeInTheDocument();

    // Symbol from recent calls
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();

    // Win/Loss/Hold badges
    expect(screen.getByText('Win')).toBeInTheDocument();
    expect(screen.getByText('Loss')).toBeInTheDocument();
    expect(screen.getByText('Hold')).toBeInTheDocument();

    // Alpha values
    expect(screen.getByText('+3.5%')).toBeInTheDocument();
    expect(screen.getByText('-2.0%')).toBeInTheDocument();
  });

  it('collapsing a row hides recent calls', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([FULL_ROW]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('Technical')).toBeInTheDocument());

    // Expand
    fireEvent.click(screen.getByTestId('agent-row-technical'));
    expect(screen.getByTestId('recent-calls-table')).toBeInTheDocument();

    // Collapse again
    fireEvent.click(screen.getByTestId('agent-row-technical'));
    expect(screen.queryByTestId('recent-calls-table')).not.toBeInTheDocument();
  });

  it('renders the How-to-read panel collapsed by default and expands it', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([FULL_ROW]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('Technical')).toBeInTheDocument());

    // Panel exists but content is hidden
    expect(screen.getByText('How to read this board')).toBeInTheDocument();
    expect(screen.queryByTestId('how-to-read-content')).not.toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByTestId('how-to-read-toggle'));
    expect(screen.getByTestId('how-to-read-content')).toBeInTheDocument();
    expect(screen.getByText(/baseline 1\.0/i)).toBeInTheDocument();
  });

  it('shows hold result and null alpha as "—" in recent calls', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([FULL_ROW]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('Technical')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('agent-row-technical'));

    // MSFT row in recent-calls: stance=0 (hold) and alpha=null → alpha cell shows "—"
    const table = screen.getByTestId('recent-calls-table');
    // Find the row whose first cell contains "MSFT"
    const allRows = table.querySelectorAll('tbody tr');
    const msftRow = Array.from(allRows).find((row) => row.textContent.includes('MSFT'));
    expect(msftRow).toBeTruthy();
    // Last cell is Alpha
    const tds = msftRow.querySelectorAll('td');
    expect(tds[tds.length - 1].textContent).toBe('—');
  });
});
