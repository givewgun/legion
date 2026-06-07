import { LineChart, Newspaper, Users, Zap, Bot } from 'lucide-react';

// agent_id -> identity. `hex` is for chart/SVG colors; `classes` hold COMPLETE
// Tailwind class strings (never interpolate class names — Tailwind would purge them).
// Note: `hex` uses the −600 shade (brighter, for chart/SVG line contrast) while
// `classes.text` uses −700 (for readable UI text). The one-step gap is intentional.
export const AGENTS = {
  technical: {
    label: 'Technical',
    Icon: LineChart,
    hex: '#d97706',
    classes: { text: 'text-amber-700', bg: 'bg-amber-100', ring: 'ring-amber-200' },
  },
  news: {
    label: 'News',
    Icon: Newspaper,
    hex: '#2563eb',
    classes: { text: 'text-blue-700', bg: 'bg-blue-100', ring: 'ring-blue-200' },
  },
  social: {
    label: 'Social',
    Icon: Users,
    hex: '#7c3aed',
    classes: { text: 'text-violet-700', bg: 'bg-violet-100', ring: 'ring-violet-200' },
  },
  contrarian: {
    label: 'Contrarian',
    Icon: Zap,
    hex: '#16a34a',
    classes: { text: 'text-green-700', bg: 'bg-green-100', ring: 'ring-green-200' },
  },
};

const FALLBACK = {
  Icon: Bot,
  hex: '#64748b',
  classes: { text: 'text-slate-600', bg: 'bg-slate-100', ring: 'ring-slate-200' },
};

export function agentInfo(agentId) {
  const found = AGENTS[agentId];
  if (found) return found;
  return { label: agentId, ...FALLBACK };
}
