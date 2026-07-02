import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AgentConfig } from '../../src/pages/AgentConfig.jsx';
import { api } from '../../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('AgentConfig', () => {
  it('renders one row per agent with its provider selected', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([
      { id: 'technical', weight: 1.0, provider: 'local', model: null, enabled: true },
      { id: 'news', weight: 1.2, provider: 'gemini', model: 'gemini-2.5-flash', enabled: true },
    ]);
    render(<AgentConfig />);
    await waitFor(() => expect(screen.getByText('technical')).toBeInTheDocument());
    const select = screen.getByLabelText('provider-news');
    expect(select.value).toBe('gemini');
  });

  it('runs a full sweep from the Operations panel and reports the kicked count', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([]);
    const trigger = vi
      .spyOn(api, 'triggerAllCycles')
      .mockResolvedValue({ kicked: [{ symbol: 'NVDA' }, { symbol: 'MU' }] });
    render(<AgentConfig />);
    fireEvent.click(screen.getByLabelText('run-all-cycles'));
    await waitFor(() => expect(screen.getByText('Kicked 2 tickers')).toBeInTheDocument());
    expect(trigger).toHaveBeenCalled();
  });

  it('relearns reliability from the Operations panel and reports the summary', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([]);
    vi.spyOn(api, 'relearnReliability').mockResolvedValue({
      resolved: 3,
      correlations: 6,
      agents: 4,
    });
    render(<AgentConfig />);
    fireEvent.click(screen.getByLabelText('relearn-reliability'));
    await waitFor(() =>
      expect(
        screen.getByText('Relearned: 3 signals resolved, 4 agent dials recomputed'),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces an Operations failure instead of swallowing it', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([]);
    vi.spyOn(api, 'triggerAllCycles').mockRejectedValue(new Error('API POST /api/trigger failed: 503'));
    render(<AgentConfig />);
    fireEvent.click(screen.getByLabelText('run-all-cycles'));
    await waitFor(() =>
      expect(screen.getByText(/Running all cycles failed: .*503/)).toBeInTheDocument(),
    );
  });

  it('saves a provider change via setAgent', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([
      { id: 'technical', weight: 1.0, provider: 'local', model: null, enabled: true },
    ]);
    const setAgent = vi.spyOn(api, 'setAgent').mockResolvedValue({});
    render(<AgentConfig />);
    await waitFor(() => expect(screen.getByText('technical')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('provider-technical'), { target: { value: 'gemini' } });
    fireEvent.click(screen.getByLabelText('save-technical'));
    await waitFor(() =>
      expect(setAgent).toHaveBeenCalledWith(
        'technical',
        expect.objectContaining({ provider: 'gemini' }),
      ),
    );
  });
});
