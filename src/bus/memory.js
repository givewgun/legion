// In-process bus double matching the createBus interface, with NATS-style
// wildcard subjects: '*' matches exactly one token, '>' matches one or more
// trailing tokens. Dispatch is synchronous (useful for deterministic tests).
function matches(pattern, subject) {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length >= i + 1;
    if (i >= s.length) return false;
    if (p[i] === '*') continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export function createMemoryBus() {
  const subs = [];
  return {
    publishJSON(subject, payload) {
      for (const { pattern, handler } of subs) {
        if (matches(pattern, subject)) handler(payload);
      }
    },
    subscribeJSON(pattern, handler) {
      subs.push({ pattern, handler });
    },
    async close() {},
  };
}
