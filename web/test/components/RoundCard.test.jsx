import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoundCard } from '../../src/components/RoundCard.jsx';

const round = {
  round_no: 2,
  s_score: 1.62,
  dispersion: 0.12,
  quorum: 0.91,
  converged: true,
  votes: [
    { agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    { agent_id: 'news', stance: 1, conviction: 0.8, weight: 1, rationale: 'guidance raise' },
  ],
};

describe('RoundCard', () => {
  it('shows the round number, metrics, and each vote', () => {
    render(<RoundCard round={round} />);
    expect(screen.getByText(/Round 2/i)).toBeInTheDocument();
    expect(screen.getByText(/1.62/)).toBeInTheDocument(); // S
    expect(screen.getByText(/0.12/)).toBeInTheDocument(); // V
    expect(screen.getByText('technical')).toBeInTheDocument();
    expect(screen.getByText('news')).toBeInTheDocument();
  });

  it('marks a converged round', () => {
    render(<RoundCard round={round} />);
    expect(screen.getByText(/converged/i)).toBeInTheDocument();
  });
});
