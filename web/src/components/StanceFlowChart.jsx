import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
} from 'recharts';
import { agentInfo } from '../lib/agents.js';
import { stanceSeries } from '../lib/debate.js';

const STANCE_TICKS = [-2, -1, 0, 1, 2];

export function StanceFlowChart({ rounds, consensusS }) {
  const { agents, data } = stanceSeries(rounds);
  if (data.length === 0) return null;
  return (
    <div className="h-56 w-full" data-testid="stance-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
          <XAxis dataKey="round" tickFormatter={(r) => `R${r}`} stroke="#94a3b8" fontSize={12} />
          <YAxis domain={[-2, 2]} ticks={STANCE_TICKS} stroke="#94a3b8" fontSize={12} />
          <Tooltip />
          {typeof consensusS === 'number' && (
            <ReferenceLine y={consensusS} stroke="#4f46e5" strokeDasharray="4 4" />
          )}
          <Legend />
          {agents.map((id) => (
            <Line
              key={id}
              type="monotone"
              dataKey={id}
              name={agentInfo(id).label}
              stroke={agentInfo(id).hex}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
