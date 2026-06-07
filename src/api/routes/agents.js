import { Router } from 'express';
import { DEFAULT_MODELS } from '../../llm/provider.js';

// Static roster (ids + prior weights) — mirrors each agent's src/agents/<id>/config.js.
export const ROSTER = [
  { id: 'technical', weight: 1.0 },
  { id: 'news', weight: 1.2 },
  { id: 'social', weight: 0.8 },
  { id: 'contrarian', weight: 0.9 },
];

const VALID_PROVIDERS = new Set(Object.keys(DEFAULT_MODELS));

// GET /api/agents → roster merged with persisted per-agent config (defaults applied).
// PATCH /api/agents/:id → upsert { provider, model, enabled } (validates id + provider).
export function agentRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const cfg = await repo.getAllAgentConfig();
      res.json(
        ROSTER.map((a) => ({
          ...a,
          provider: cfg[a.id]?.provider ?? 'local',
          model: cfg[a.id]?.model ?? null,
          enabled: cfg[a.id]?.enabled ?? true,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!ROSTER.some((a) => a.id === id)) {
        return res.status(404).json({ error: `unknown agent: ${id}` });
      }
      const { provider = 'local', model = null, enabled = true } = req.body ?? {};
      if (!VALID_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: `unknown provider: ${provider}` });
      }
      await repo.upsertAgentConfig(id, { provider, model, enabled });
      res.json({ id, provider, model, enabled });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
