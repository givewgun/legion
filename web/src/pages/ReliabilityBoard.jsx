import { useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { api } from '../api/client.js';
import { agentInfo } from '../lib/agents.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

export function ReliabilityBoard() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getReliability()
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (rows && rows.length === 0) return <p className="text-slate-400">No reliability data yet.</p>;

  const data = (rows ?? []).map((r) => ({ ...r, label: agentInfo(r.agentId).label }));

  return (
    <div>
      <PageHeader title="Agent reliability" subtitle="How often each agent has been right (ρ)" />
      <Card className="mb-5 p-3">
        <div className="h-56 w-full" data-testid="reliability-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 24, right: 16 }}>
              <XAxis type="number" domain={[0, 1]} stroke="#94a3b8" fontSize={12} />
              <YAxis type="category" dataKey="label" stroke="#94a3b8" fontSize={12} width={80} />
              <Tooltip />
              <Bar dataKey="rho" radius={[0, 4, 4, 0]}>
                {data.map((r) => (
                  <Cell key={r.agentId} fill={agentInfo(r.agentId).hex} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-medium text-slate-500">Agent</th>
              <th className="px-4 py-2 font-medium text-slate-500">ρ</th>
              <th className="px-4 py-2 font-medium text-slate-500">Sample</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.agentId} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{agentInfo(r.agentId).label}</td>
                <td className="px-4 py-2">{r.rho.toFixed(2)}</td>
                <td className="px-4 py-2 text-slate-500">{r.sampleSize}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
