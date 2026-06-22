// Mirror of src/llm/source.js (web is a separate bundle, no shared import).
// pc → onprem; every other backend → cloud; null/absent → null.
export function locationForSource(source) {
  if (source == null) return null;
  return source === 'pc' ? 'onprem' : 'cloud';
}
