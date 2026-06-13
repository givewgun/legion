import { connect, StringCodec, headers as natsHeaders } from 'nats';
import { context, propagation } from '@opentelemetry/api';
import {
  cyclesTotal,
  cycleDuration,
  votesTotal,
  signalsTotal,
  consensusRounds,
} from '../instrumentation/metrics.js';

const sc = StringCodec();

// cycleId -> epoch ms of the round-1 cycle publish, for cycle-duration timing.
const cycleStart = new Map();

// Derive the pipeline metrics from the subjects flowing over the bus. This is the
// single choke point every cycle/vote/consensus message passes through, so one
// place captures throughput without touching every agent. Best-effort only.
function recordPublish(subject, payload) {
  try {
    if (subject.startsWith('legion.cycle.')) {
      if (!payload?.round || payload.round === 1) {
        cyclesTotal.inc({ status: 'started' });
        if (payload?.cycleId) cycleStart.set(payload.cycleId, Date.now());
      }
    } else if (subject.startsWith('legion.vote.')) {
      votesTotal.inc({ agent: payload?.vote?.agentId || 'unknown' });
    } else if (subject.startsWith('legion.consensus.')) {
      cyclesTotal.inc({ status: 'completed' });
      signalsTotal.inc();
      if (typeof payload?.round === 'number') consensusRounds.observe(payload.round);
      const t0 = payload?.cycleId ? cycleStart.get(payload.cycleId) : null;
      if (t0) {
        cycleDuration.observe((Date.now() - t0) / 1000);
        cycleStart.delete(payload.cycleId);
      }
    }
  } catch {
    // metrics must never break the bus
  }
}

// Wraps a NATS connection with JSON publish/subscribe helpers.
// Accepts an already-open connection so it can be unit-tested with a fake.
export function createBus(connection) {
  return {
    publishJSON(subject, payload) {
      recordPublish(subject, payload);
      // Carry the active trace context across NATS so a whole cycle (scheduler ->
      // agents -> emitter) renders as one distributed trace. No-op without an SDK.
      let opts;
      try {
        const h = natsHeaders();
        propagation.inject(context.active(), h, { set: (carrier, k, v) => carrier.set(k, v) });
        opts = { headers: h };
      } catch {
        opts = undefined;
      }
      connection.publish(subject, sc.encode(JSON.stringify(payload)), opts);
    },
    async subscribeJSON(subject, handler) {
      const sub = connection.subscribe(subject);
      for await (const msg of sub) {
        const payload = JSON.parse(sc.decode(msg.data));
        let ctx = context.active();
        try {
          if (msg.headers) {
            const carrier = {};
            const keys = typeof msg.headers.keys === 'function' ? msg.headers.keys() : [];
            for (const key of keys) carrier[key] = msg.headers.get(key);
            ctx = propagation.extract(context.active(), carrier);
          }
        } catch {
          ctx = context.active();
        }
        await context.with(ctx, async () => handler(payload));
      }
    },
    async close() {
      await connection.drain();
    },
  };
}

// Opens a real connection from config and returns a bus.
export async function connectBus(natsUrl) {
  const connection = await connect({ servers: natsUrl });
  return createBus(connection);
}
