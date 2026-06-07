import { useState } from 'react';
import { motion } from 'framer-motion';

// Nodes positioned on a 320x140 viewBox.
const NODES = [
  {
    id: 'data',
    label: 'Market data',
    x: 16,
    y: 56,
    w: 56,
    fill: '#f1f5f9',
    stroke: '#cbd5e1',
    text: '#475569',
    blurb: 'Price, indicators, sentiment, and news are gathered for the ticker.',
  },
  {
    id: 'agents',
    label: 'Agents',
    x: 92,
    y: 56,
    w: 56,
    fill: '#dcfce7',
    stroke: '#16a34a',
    text: '#166534',
    blurb:
      'Four agents (technical, news, social, contrarian) each vote a stance with a conviction.',
  },
  {
    id: 'consensus',
    label: 'Consensus',
    x: 168,
    y: 56,
    w: 64,
    fill: '#dbeafe',
    stroke: '#2563eb',
    text: '#1e40af',
    blurb: 'Votes are weighted and scored (S, V, κ). Agents re-debate until the round converges.',
  },
  {
    id: 'signal',
    label: 'Signal',
    x: 252,
    y: 56,
    w: 52,
    fill: '#ede9fe',
    stroke: '#7c3aed',
    text: '#5b21b6',
    blurb: 'The converged stance becomes a BUY / HOLD / SELL signal with a conviction.',
  },
  {
    id: 'outcome',
    label: 'Outcome',
    x: 252,
    y: 104,
    w: 52,
    fill: '#fee2e2',
    stroke: '#dc2626',
    text: '#991b1b',
    blurb: 'After the horizon, the signal is scored against the actual forward return vs SPY/QQQ.',
  },
  {
    id: 'reliability',
    label: 'Reliability ρ',
    x: 92,
    y: 104,
    w: 76,
    fill: '#fef3c7',
    stroke: '#d97706',
    text: '#92400e',
    blurb: "Each agent's hit rate updates its reliability ρ, which re-weights its future votes.",
  },
];

export function ConsensusPipeline() {
  const [active, setActive] = useState(null);
  const info = NODES.find((n) => n.id === active);
  return (
    <div data-testid="consensus-pipeline">
      <svg width="100%" viewBox="0 0 320 140" role="img" aria-label="Legion processing pipeline">
        {/* connectors */}
        <g stroke="#cbd5e1" fill="none" strokeWidth="1.5">
          <line x1="72" y1="72" x2="92" y2="72" />
          <line x1="148" y1="72" x2="168" y2="72" />
          <line x1="232" y1="72" x2="252" y2="72" />
          <line x1="278" y1="84" x2="278" y2="104" />
          <line x1="252" y1="116" x2="168" y2="118" />
          <line x1="120" y1="104" x2="120" y2="84" strokeDasharray="3 3" />
        </g>
        {NODES.map((n) => (
          <g
            key={n.id}
            onMouseEnter={() => setActive(n.id)}
            onMouseLeave={() => setActive(null)}
            style={{ cursor: 'pointer' }}
          >
            <rect x={n.x} y={n.y} width={n.w} height="24" rx="6" fill={n.fill} stroke={n.stroke} />
            <text x={n.x + n.w / 2} y={n.y + 15} fontSize="9" textAnchor="middle" fill={n.text}>
              {n.label}
            </text>
          </g>
        ))}
        <motion.circle
          r="4"
          fill="#4f46e5"
          animate={{
            cx: [44, 120, 200, 278, 278, 130, 44],
            cy: [68, 68, 68, 68, 116, 116, 68],
          }}
          transition={{ duration: 6, repeat: Infinity, ease: 'linear' }}
        />
      </svg>
      <p className="mt-2 min-h-[2.5rem] text-sm text-slate-600">
        {info ? (
          <>
            <span className="font-semibold text-slate-800">{info.label}:</span> {info.blurb}
          </>
        ) : (
          "Hover a stage to see what it does. The pulse shows the self-learning loop: outcomes update each agent's reliability, which re-weights the next debate."
        )}
      </p>
    </div>
  );
}
