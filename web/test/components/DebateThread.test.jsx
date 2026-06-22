import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebateThread } from '../../src/components/DebateThread.jsx';

const rounds = [
  {
    round_no: 1,
    s_score: 0,
    dispersion: 1,
    quorum: 0.5,
    converged: false,
    votes: [
      {
        agent_id: 'technical',
        stance: -1,
        conviction: 0.6,
        weight: 1,
        rationale:
          'A very long rationale that must be shown in full without being truncated anywhere',
      },
    ],
  },
  {
    round_no: 2,
    s_score: 1,
    dispersion: 0,
    quorum: 1,
    converged: true,
    votes: [
      { agent_id: 'technical', stance: 1, conviction: 0.7, weight: 1, rationale: 'support held' },
    ],
  },
];

describe('DebateThread', () => {
  it('renders full rationale text (not truncated)', () => {
    render(<DebateThread rounds={rounds} />);
    expect(
      screen.getByText(/long rationale that must be shown in full without being truncated/i),
    ).toBeInTheDocument();
  });

  it('shows a stance delta for round 2', () => {
    render(<DebateThread rounds={rounds} />);
    expect(screen.getByText('+2')).toBeInTheDocument(); // -1 -> 1
  });

  it('shows the round metrics', () => {
    render(<DebateThread rounds={rounds} />);
    expect(screen.getByText(/Round 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Round 2/i)).toBeInTheDocument();
  });

  it('renders a model · location badge', () => {
    const rounds = [
      { round_no: 1, converged: true, s_score: 2, dispersion: 0, quorum: 1,
        votes: [{ agent_id: 'news', stance: 1, conviction: 0.5, rationale: 'r', model: 'gpt-oss:20b', source: 'pc' }] },
    ];
    render(<DebateThread rounds={rounds} />);
    expect(screen.getByText(/gpt-oss:20b · onprem/)).toBeInTheDocument();
  });
});
