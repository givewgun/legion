import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../src/auth/AuthContext.jsx';
import { LoginGate } from '../src/auth/LoginGate.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

function renderGate() {
  return render(
    <AuthProvider>
      <LoginGate>
        <div>secret dashboard</div>
      </LoginGate>
    </AuthProvider>,
  );
}

describe('LoginGate', () => {
  it('shows the sign-in button when unauthenticated', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(null);
    renderGate();
    await waitFor(() => expect(screen.getByText(/sign in with google/i)).toBeInTheDocument());
    expect(screen.queryByText('secret dashboard')).not.toBeInTheDocument();
  });

  it('renders children when authenticated', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue({ id: 1, email: 'a@b.com', name: 'A' });
    renderGate();
    await waitFor(() => expect(screen.getByText('secret dashboard')).toBeInTheDocument());
  });
});
