import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LearnPage } from '../../src/pages/LearnPage.jsx';

describe('LearnPage', () => {
  it('renders the title and the pipeline diagram', () => {
    render(<LearnPage />);
    expect(screen.getByRole('heading', { name: /How Legion works/i })).toBeInTheDocument();
    expect(screen.getByTestId('consensus-pipeline')).toBeInTheDocument();
  });

  it('explains all four stages', () => {
    render(<LearnPage />);
    // Use headings so a stage word appearing in the pipeline blurb doesn't cause a double match.
    expect(screen.getByRole('heading', { name: /The debate/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Convergence/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Backtesting/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Self-learning/i })).toBeInTheDocument();
  });

  it('states the convergence rule', () => {
    render(<LearnPage />);
    expect(screen.getByText(/κ ≥ quorum/i)).toBeInTheDocument();
  });
});
