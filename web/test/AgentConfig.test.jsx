import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentConfig } from '../src/pages/AgentConfig.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('AgentConfig', () => {
  it('renders the home-pc-enabled checkbox with fetched state', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([]);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ homePcEnabled: false });

    render(<AgentConfig />);

    const checkbox = await screen.findByLabelText('home-pc-enabled');
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it('calls setSettings with new boolean when toggled', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([]);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ homePcEnabled: false });
    const setSettings = vi.spyOn(api, 'setSettings').mockResolvedValue({ homePcEnabled: true });

    render(<AgentConfig />);

    const checkbox = await screen.findByLabelText('home-pc-enabled');
    await waitFor(() => expect(checkbox).not.toBeChecked());

    await userEvent.click(checkbox);

    expect(setSettings).toHaveBeenCalledWith({ homePcEnabled: true });
  });
});
