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
};

describe('RuntimeSettings', () => {
  it('renders the home model as a dropdown of the PC models and saves the selection', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({ settings: SETTINGS });
    vi.spyOn(api, 'getPcModels').mockResolvedValue({ models: ['qwen3:8b', 'qwen3:14b'] });
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

  it('falls back to a free-text model input when the PC reports no models', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({ settings: SETTINGS });
    vi.spyOn(api, 'getPcModels').mockResolvedValue({ models: [] });

    render(<RuntimeSettings />);

    const input = await screen.findByLabelText('home_model');
    expect(input.tagName).toBe('INPUT');
  });
});
