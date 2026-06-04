import { connect, StringCodec } from 'nats';

const sc = StringCodec();

// Wraps a NATS connection with JSON publish/subscribe helpers.
// Accepts an already-open connection so it can be unit-tested with a fake.
export function createBus(connection) {
  return {
    publishJSON(subject, payload) {
      connection.publish(subject, sc.encode(JSON.stringify(payload)));
    },
    async subscribeJSON(subject, handler) {
      const sub = connection.subscribe(subject);
      for await (const msg of sub) {
        handler(JSON.parse(sc.decode(msg.data)));
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
