// Prometheus metrics for every Legion process. Defines a shared registry +
// Node defaults + the signal-pipeline metrics, an HTTP RED middleware for the
// read API, and a tiny /metrics server (started by otel.mjs in each container).
//
// Importing this module only DEFINES metrics (safe in tests); the server is
// started explicitly via startMetricsServer().
import client from 'prom-client';
import http from 'node:http';

const SERVICE = process.env.OTEL_SERVICE_NAME || 'legion';

export const register = client.register;
register.setDefaultLabels({ service: SERVICE });
client.collectDefaultMetrics();

// HTTP RED (read API)
export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['service', 'method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

// Signal pipeline
export const cyclesTotal = new client.Counter({
  name: 'legion_cycles_total',
  help: 'Legion evaluation cycles by status',
  labelNames: ['status'],
});
export const cycleDuration = new client.Histogram({
  name: 'legion_cycle_duration_seconds',
  help: 'Wall-clock duration of a cycle (start -> consensus)',
  buckets: [1, 5, 15, 30, 60, 120, 300],
});
export const votesTotal = new client.Counter({
  name: 'legion_votes_total',
  help: 'Votes published on the bus',
  labelNames: ['agent'],
});
export const signalsTotal = new client.Counter({
  name: 'legion_signals_total',
  help: 'Consensus signals emitted',
});
export const consensusRounds = new client.Histogram({
  name: 'legion_consensus_rounds',
  help: 'Debate rounds taken to reach consensus',
  buckets: [1, 2, 3, 4, 5],
});
export const agentInference = new client.Histogram({
  name: 'legion_agent_inference_seconds',
  help: 'End-to-end agent reasoning time (gather excluded where possible)',
  labelNames: ['agent'],
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80],
});
export const ollamaRequest = new client.Histogram({
  name: 'legion_ollama_request_seconds',
  help: 'Ollama /api/generate latency',
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 160],
});

export const ollamaThinkingChars = new client.Histogram({
  name: 'legion_ollama_thinking_chars',
  help: 'Characters of thinking-mode reasoning emitted per Ollama generate',
  buckets: [0, 100, 500, 1000, 2000, 5000, 10000, 20000],
});

export function httpMetricsMiddleware(req, res, next) {
  if (req.path === '/metrics') return next();
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? (req.baseUrl || '') + req.route.path : 'other';
    end({ service: SERVICE, method: req.method, route, status_code: res.statusCode });
  });
  next();
}

export function startMetricsServer(port = Number(process.env.METRICS_PORT || 9100)) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    } else if (req.url === '/healthz') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  // Never crash a worker over the metrics port (e.g. a stray double-bind).
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error('[metrics] server error:', err.message);
  });
  server.listen(port, () => console.log(`[metrics] exposing :${port}/metrics`));
  return server;
}
