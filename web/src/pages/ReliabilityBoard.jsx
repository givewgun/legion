import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

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
  if (rows && rows.length === 0) {
    return <p className="text-slate-400">No reliability data yet.</p>;
  }

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Agent reliability</h2>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200">
            <th className="py-2">Agent</th>
            <th className="py-2">ρ (reliability)</th>
            <th className="py-2">Sample</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.agentId} className="border-b border-slate-100">
              <td className="py-2 font-medium">{r.agentId}</td>
              <td className="py-2">{r.rho.toFixed(2)}</td>
              <td className="py-2 text-slate-500">{r.sampleSize}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
