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
