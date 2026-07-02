import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuntimeSettings } from '../src/pages/RuntimeSettings.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

const SETTINGS = {
  home_pc_enabled: { value: true, source: 'default', default: true, type: 'bool', label: 'Use home PC model' },
  home_model: { value: 'qwen3:14b', source: 'default', default: 'qwen3:14b', type: 'string', label: 'Home PC model' },
  home_fallback: { value: false, source: 'db', default: true, type: 'bool', label: 'Allow Oracle fallback' },
  oracle_model: { value: 'qwen3:4b', source: 'default', default: 'qwen3:4b', type: 'string', label: 'Oracle fallback model' },
};

// The form fetches both model lists on mount; default them to empty so each
// test only mocks the list it cares about.
function mockLists({ pc = [], oracle = [] } = {}) {
  vi.spyOn(api, 'getSettings').mockResolvedValue({ settings: SETTINGS });
  vi.spyOn(api, 'getPcModels').mockResolvedValue({ models: pc });
  vi.spyOn(api, 'getOracleModels').mockResolvedValue({ models: oracle });
}

describe('RuntimeSettings', () => {
  it('renders the home model as a dropdown of the PC models and saves the selection', async () => {
    mockLists({ pc: ['qwen3:8b', 'qwen3:14b'] });
    const setSettings = vi
      .spyOn(api, 'setSettings')
      .mockResolvedValue({ settings: { ...SETTINGS, home_model: { ...SETTINGS.home_model, value: 'qwen3:8b', source: 'db' } } });

    render(<RuntimeSettings />);

    const select = await screen.findByLabelText('home_model');
    await userEvent.selectOptions(select, 'qwen3:8b');
    await userEvent.click(screen.getByLabelText('save-settings'));

    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(setSettings.mock.calls[0][0].home_model).toBe('qwen3:8b');
  });

  it("renders the oracle model as a dropdown of the Oracle box's models and saves the selection", async () => {
    mockLists({ oracle: ['qwen3:4b', 'qwen2.5:7b-instruct'] });
    const setSettings = vi
      .spyOn(api, 'setSettings')
      .mockResolvedValue({ settings: { ...SETTINGS, oracle_model: { ...SETTINGS.oracle_model, value: 'qwen2.5:7b-instruct', source: 'db' } } });

    render(<RuntimeSettings />);

    const select = await screen.findByLabelText('oracle_model');
    expect(select.tagName).toBe('SELECT');
    await userEvent.selectOptions(select, 'qwen2.5:7b-instruct');
    await userEvent.click(screen.getByLabelText('save-settings'));

    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(setSettings.mock.calls[0][0].oracle_model).toBe('qwen2.5:7b-instruct');
  });

  it('keeps the current oracle model selectable when it is not in the pulled list', async () => {
    mockLists({ oracle: ['qwen2.5:7b-instruct'] });

    render(<RuntimeSettings />);

    const select = await screen.findByLabelText('oracle_model');
    // current value (qwen3:4b) is prepended even though the box hasn't pulled it
    expect([...select.options].map((o) => o.value)).toEqual(['qwen3:4b', 'qwen2.5:7b-instruct']);
    expect(select.value).toBe('qwen3:4b');
  });

  it('falls back to a free-text model input when a box reports no models', async () => {
    mockLists();

    render(<RuntimeSettings />);

    const homeInput = await screen.findByLabelText('home_model');
    expect(homeInput.tagName).toBe('INPUT');
    expect(screen.getByLabelText('oracle_model').tagName).toBe('INPUT');
  });
});
