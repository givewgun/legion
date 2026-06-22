// Display class for a served-backend source id. The home PC is the only on-prem
// box; every other backend (Oracle VM, OpenAI, Gemini) is cloud. A null/absent
// source (e.g. a fetch-failed abstain that never reached a provider) → null.
export function locationForSource(source) {
  if (source == null) return null;
  return source === 'pc' ? 'onprem' : 'cloud';
}
