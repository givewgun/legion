import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReliabilityBoard } from '../../src/pages/ReliabilityBoard.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

describe('ReliabilityBoard', () => {
  it('renders a bar chart wrapper and the exact-numbers table', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([
      { agentId: 'technical', rho: 0.62, sampleSize: 40 },
      { agentId: 'news', rho: 0.55, sampleSize: 30 },
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
});
