import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from '../../src/ui/Card.jsx';
import { Badge } from '../../src/ui/Badge.jsx';
import { StatTile } from '../../src/ui/StatTile.jsx';
import { ConvictionBar } from '../../src/ui/ConvictionBar.jsx';
import { AgentAvatar } from '../../src/ui/AgentAvatar.jsx';
import { PageHeader } from '../../src/ui/PageHeader.jsx';

describe('ui primitives', () => {
  it('Card renders children', () => {
    render(<Card>hello</Card>);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('Badge colors a BUY band green and a SELL band red', () => {
    const { rerender } = render(<Badge band="STRONG_BUY" />);
    expect(screen.getByText('STRONG_BUY').className).toMatch(/green/);
    rerender(<Badge band="SELL" />);
    expect(screen.getByText('SELL').className).toMatch(/red/);
  });

  it('StatTile shows a label and value', () => {
    render(<StatTile label="Signals" value="12" />);
    expect(screen.getByText('Signals')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('ConvictionBar sets a width from the 0..1 value', () => {
    render(<ConvictionBar value={0.82} band="BUY" />);
    const fill = screen.getByTestId('conviction-fill');
    expect(fill.style.width).toBe('82%');
  });

  it('AgentAvatar labels by agent and renders an icon', () => {
    render(<AgentAvatar agentId="technical" />);
    expect(screen.getByLabelText('Technical')).toBeInTheDocument();
  });

  it('PageHeader renders a title and subtitle', () => {
    render(<PageHeader title="Backtest" subtitle="vs SPY/QQQ" />);
    expect(screen.getByRole('heading', { name: 'Backtest' })).toBeInTheDocument();
    expect(screen.getByText('vs SPY/QQQ')).toBeInTheDocument();
  });
});
