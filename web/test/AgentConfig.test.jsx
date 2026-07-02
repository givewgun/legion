import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentConfig } from '../src/pages/AgentConfig.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

// The page fetches agents, settings, both model lists, and the ticker roster on
// mount — stub them all so each test only overrides what it exercises.
function mockPage() {
  vi.spyOn(api, 'listAgents').mockResolvedValue([
    { id: 'technical', weight: 1, provider: 'local', model: null, enabled: true },
  ]);
  vi.spyOn(api, 'getSettings').mockResolvedValue({ settings: {} });
  vi.spyOn(api, 'getPcModels').mockResolvedValue({ models: [] });
  vi.spyOn(api, 'getOracleModels').mockResolvedValue({ models: [] });
  vi.spyOn(api, 'listTickers').mockResolvedValue([
    { symbol: 'MU', enabled: true },
    { symbol: 'NVDA', enabled: true },
    { symbol: 'OLD', enabled: false },
  ]);
}

describe('AgentConfig', () => {
  it('renders the agent rows and embeds the runtime settings section', async () => {
    mockPage();

    render(<AgentConfig />);

    expect(await screen.findByText('technical')).toBeInTheDocument();
    expect(await screen.findByLabelText('provider-technical')).toBeInTheDocument();
  });

  it('stops all cycles from the operations row', async () => {
    mockPage();
    const stopAll = vi
      .spyOn(api, 'stopAllCycles')
      .mockResolvedValue({ stopping: [{ id: 1, symbol: 'NVDA' }] });

    render(<AgentConfig />);
    await userEvent.click(await screen.findByLabelText('stop-all-cycles'));

    await waitFor(() => expect(stopAll).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Stopping 1 cycle/)).toBeInTheDocument();
  });

  it('runs and stops a selected ticker (enabled tickers only in the list)', async () => {
    mockPage();
    const trigger = vi
      .spyOn(api, 'triggerTicker')
      .mockResolvedValue({ symbol: 'NVDA', cycleId: 7 });
    const stop = vi
      .spyOn(api, 'stopTicker')
      .mockResolvedValue({ symbol: 'NVDA', stopping: [{ id: 7, symbol: 'NVDA' }] });

    render(<AgentConfig />);

    const select = await screen.findByLabelText('ticker-select');
    expect([...select.options].map((o) => o.value)).toEqual(['MU', 'NVDA']); // disabled OLD excluded
    await userEvent.selectOptions(select, 'NVDA');

    await userEvent.click(screen.getByLabelText('run-ticker'));
    await waitFor(() => expect(trigger).toHaveBeenCalledWith('NVDA'));

    await userEvent.click(screen.getByLabelText('stop-ticker'));
    await waitFor(() => expect(stop).toHaveBeenCalledWith('NVDA'));
  });

  it('resets reliability only after the confirm dialog is accepted', async () => {
    mockPage();
    const reset = vi.spyOn(api, 'resetReliability').mockResolvedValue({
      cleared: { agent_reliability: 4, signal_votes: 40 },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<AgentConfig />);
    await userEvent.click(await screen.findByLabelText('reset-reliability'));
    expect(reset).not.toHaveBeenCalled(); // declined

    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByLabelText('reset-reliability'));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/44 rows cleared/)).toBeInTheDocument();
  });
});
