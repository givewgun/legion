export const STANCE = Object.freeze({
  STRONG_SELL: -2,
  SELL: -1,
  HOLD: 0,
  BUY: 1,
  STRONG_BUY: 2,
});

const VALID = new Set([-2, -1, 0, 1, 2]);

export function isValidStance(value) {
  return Number.isInteger(value) && VALID.has(value);
}

export function sideOf(stance) {
  return Math.sign(stance);
}

// Maps an aggregate score S to a label. holdBand is the neutral half-width:
// |S| < holdBand → HOLD; otherwise SELL/BUY, escalating to STRONG past 1.5.
export function stanceBand(score, holdBand) {
  if (Math.abs(score) < holdBand) return 'HOLD';
  if (score >= 1.5) return 'STRONG_BUY';
  if (score > 0) return 'BUY';
  if (score <= -1.5) return 'STRONG_SELL';
  return 'SELL';
}
