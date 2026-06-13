// Per-process bootstrap, loaded via `node --import ./src/instrumentation/otel.mjs`.
// Starts the Prometheus /metrics endpoint and OpenTelemetry tracing for every
// Legion container. Best-effort: a telemetry failure must never take down a worker.
import { startMetricsServer } from './metrics.js';

try {
  startMetricsServer();
} catch (err) {
  console.error('[metrics] disabled:', err && err.message);
}

if (process.env.NODE_ENV === 'test' || process.env.OTEL_SDK_DISABLED === 'true') {
  // skip OTel in CI/tests — no collector reachable
} else try {
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');

  const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://oculory-alloy:4317';
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  process.on('SIGTERM', () => {
    sdk.shutdown().catch(() => {});
  });
} catch (err) {
  console.error('[otel] tracing disabled:', err && err.message);
}
