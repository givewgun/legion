import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentConfig } from '../src/pages/AgentConfig.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('AgentConfig', () => {
  it('renders the agent rows and embeds the runtime settings section', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([
      { id: 'technical', weight: 1, provider: 'local', model: null, enabled: true },
    ]);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ settings: {} });
    vi.spyOn(api, 'getPcModels').mockResolvedValue({ models: [] });

    render(<AgentConfig />);

    expect(await screen.findByText('technical')).toBeInTheDocument();
    expect(await screen.findByLabelText('provider-technical')).toBeInTheDocument();
  });
});
