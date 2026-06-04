// Local LLM provider backed by the Ollama HTTP API.
// fetchImpl is injectable for testing; defaults to global fetch (Node >=18).
export function createOllamaProvider({ url, model }, fetchImpl = fetch) {
  return {
    name: 'local',
    async generate({ system, prompt }) {
      const res = await fetchImpl(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, system, prompt, stream: false }),
      });
      if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
      const data = await res.json();
      return data.response;
    },
  };
}
