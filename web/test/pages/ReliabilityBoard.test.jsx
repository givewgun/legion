import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReliabilityBoard } from '../../src/pages/ReliabilityBoard.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ReliabilityBoard', () => {
  it('renders each agent with its rho', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([
      { agentId: 'technical', rho: 1.42, sampleSize: 20 },
      { agentId: 'news', rho: 0.81, sampleSize: 15 },
    ]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('technical')).toBeInTheDocument());
    expect(screen.getByText('1.42')).toBeInTheDocument();
    expect(screen.getByText('news')).toBeInTheDocument();
  });

  it('shows an empty state when no reliability data yet', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText(/no reliability data/i)).toBeInTheDocument());
  });
});
