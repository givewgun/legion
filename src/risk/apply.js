// Applies a risk constraint to a converged signal. Constrains magnitude/entry
// only — never flips direction (leaderless purity: risk constrains, it does not
// decide). Returns a new signal; the input is left untouched.
export function applyRiskConstraint(signal, constraint) {
  if (!constraint) return signal;

  const plan = { ...signal.plan, riskReason: constraint.reason };
  let { band, conviction } = signal;

  if (constraint.blockBuy && (band === 'BUY' || band === 'STRONG_BUY')) {
    band = 'HOLD';
    conviction = 0;
    plan.riskBlocked = true;
  } else if (conviction > constraint.capConviction) {
    conviction = constraint.capConviction;
    plan.riskCapped = true;
  }

  return { ...signal, band, conviction, plan };
}
