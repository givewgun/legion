import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from '../src/App.jsx';
import { api } from '../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
  // Every page does a fetch on mount; stub them so routing tests stay isolated.
  vi.spyOn(api, 'listSignals').mockResolvedValue([]);
  vi.spyOn(api, 'listCycleTickers').mockResolvedValue([]);
  vi.spyOn(api, 'getReliability').mockResolvedValue([]);
  vi.spyOn(api, 'getBacktest').mockResolvedValue([]);
  vi.spyOn(api, 'listTickers').mockResolvedValue([]);
});

describe('App shell + routing', () => {
  it('renders the nav and the Signals page at /', async () => {
    render(<App />);
    expect(screen.getByRole('link', { name: /Signals/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Learn/i })).toBeInTheDocument();
    await waitFor(() => expect(api.listSignals).toHaveBeenCalled());
  });

  it('navigates to the Learn page when its nav link is clicked', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('link', { name: /Learn/i }));
    expect(await screen.findByRole('heading', { name: /How Legion works/i })).toBeInTheDocument();
  });
});
