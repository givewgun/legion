// At-rest encryption for broker credentials stored in legion.broker_connections
// (ADR 0036). AES-256-GCM with a key derived from SESSION_SECRET — prod already
// requires that secret, so no new env is introduced. This protects DB dumps and
// backups; it is not a substitute for host security (the key lives in env on the
// same box). Blob format: `v1:<iv b64>:<authTag b64>:<ciphertext b64>`.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const BlobVersion = 'v1';
const IvBytes = 12; // GCM standard nonce size

function deriveKey(secret) {
  if (!secret) throw new Error('broker credentials require SESSION_SECRET to be set');
  return createHash('sha256').update(`legion-broker-credentials:${secret}`).digest();
}

/**
 * Encrypts a credentials object into a storable blob.
 *
 * @param {object} credentials - Broker-specific credentials JSON (e.g. `{ appKey, appSecret }`).
 * @param {string} secret - The SESSION_SECRET the key is derived from.
 * @returns {string} `v1:` blob for the broker_connections.credentials column.
 */
export function encryptCredentials(credentials, secret) {
  const iv = randomBytes(IvBytes);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return [BlobVersion, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypts a stored blob back into the credentials object.
 *
 * @param {string} blob - Value from broker_connections.credentials.
 * @param {string} secret - The SESSION_SECRET the key is derived from.
 * @returns {object} The credentials JSON.
 */
export function decryptCredentials(blob, secret) {
  const [version, iv, tag, ciphertext] = String(blob).split(':');
  if (version !== BlobVersion || !iv || !tag || !ciphertext) {
    throw new Error('broker credentials blob is malformed');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong/rotated SESSION_SECRET or corrupted row — the caller surfaces
    // "re-enter credentials", never a raw crypto error.
    throw new Error('broker credentials cannot be decrypted (SESSION_SECRET changed?)');
  }
  return JSON.parse(plaintext);
}
