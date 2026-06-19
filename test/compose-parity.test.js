import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// The production compose is documented as mirroring docker-compose.yml (see its
// header). A service silently dropped from prod means that runner is never
// deployed on the VM and fails silently — exactly how the reliability
// (self-learning) cron went missing, leaving signals_resolved/agent_reliability
// permanently empty. This guards every long-lived runner against that regression.
const load = (rel) => yaml.load(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

describe('docker-compose prod/dev parity', () => {
  const dev = load('../docker-compose.yml');
  const prod = load('../docker-compose.prod.yml');

  it('production defines every service the dev compose declares', () => {
    const devServices = Object.keys(dev.services).sort();
    const prodServices = Object.keys(prod.services).sort();
    const missing = devServices.filter((s) => !prodServices.includes(s));
    expect(missing).toEqual([]);
  });

  it('runs the reliability self-learning cron in production', () => {
    const reliability = prod.services.reliability;
    expect(reliability).toBeDefined();
    expect(reliability.command).toContain('src/run/reliability.js');
  });
});
