import { createOllamaProvider } from './ollama.js';

// Factory selecting an LLM provider by name. Add 'gemini'/'openai' here later;
// the interface (generate({ system, prompt }) → string) stays stable.
export function createProvider(name, cfg, fetchImpl = fetch) {
  switch (name) {
    case 'local':
      return createOllamaProvider(cfg.ollama, fetchImpl);
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}
