import { createHash, createHmac } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';
import {
  decodeApplicationKey,
  validateApplicationKeyRing,
  parseApplicationPreviousKeys,
  type ApplicationKeyRing,
} from '../security/key-ring.js';

export type CallbackTokenIdentity = Readonly<{ id: string }>;
export type CallbackKeyConfig = Readonly<{
  origin: string;
  keys: ApplicationKeyRing;
}>;
export function parseCallbackKeyConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): CallbackKeyConfig | undefined {
  const key = environment.CALLBACK_TOKEN_KEY;
  if (key === undefined) {
    if (
      deployed ||
      environment.CALLBACK_TOKEN_KEY_VERSION !== undefined ||
      environment.CALLBACK_TOKEN_PREVIOUS_KEYS !== undefined
    )
      throw new Error(
        'Configure CALLBACK_TOKEN_KEY and CALLBACK_TOKEN_KEY_VERSION; they are required when deployed.',
      );
    return undefined;
  }
  const version = environment.CALLBACK_TOKEN_KEY_VERSION;
  if (version === undefined)
    throw new Error('Configure CALLBACK_TOKEN_KEY_VERSION.');
  const keys = validateApplicationKeyRing({
    current: { version, key },
    previous: parseApplicationPreviousKeys(
      environment.CALLBACK_TOKEN_PREVIOUS_KEYS,
    ),
  });
  if (
    deployed &&
    [keys.current, ...keys.previous].some((entry) =>
      isDevelopmentKey(entry.key),
    )
  )
    throw new Error(
      'Replace the public development CALLBACK_TOKEN_KEY before deployment.',
    );
  const origin = environment.PUBLIC_WEB_ORIGIN;
  if (origin === undefined)
    throw new Error('Configure PUBLIC_WEB_ORIGIN for callback URLs.');
  const parsed = new URL(origin);
  if (
    origin.length > 512 ||
    parsed.origin !== origin ||
    !['http:', 'https:'].includes(parsed.protocol) ||
    (deployed && parsed.protocol !== 'https:')
  )
    throw new Error(
      'PUBLIC_WEB_ORIGIN must be an origin, using HTTPS when deployed.',
    );
  return { origin, keys };
}
export const CALLBACK_DEVELOPMENT_KEY = Buffer.alloc(32, 0x46).toString(
  'base64url',
);
export function callbackTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function createCallbackTokenKeys(config: CallbackKeyConfig) {
  const keys = new Map(
    [config.keys.current, ...config.keys.previous].map((entry) => [
      entry.version,
      decodeApplicationKey(entry.key),
    ]),
  );
  let closed = false;
  return Object.freeze({
    currentVersion: config.keys.current.version,
    origin: config.origin,
    material(identity: CallbackTokenIdentity, version: string) {
      const key = keys.get(version);
      if (closed || key === undefined)
        throw new Error(
          'A stored callback key version is unavailable; restore its CALLBACK_TOKEN_PREVIOUS_KEYS entry.',
        );
      const derive = (purpose: string) =>
        createHmac('sha256', key)
          .update(canonicalJson({ purpose, version, id: identity.id }))
          .digest('base64url');
      const token = derive('pertexo.callback.address');
      return {
        token,
        url: `${config.origin}/hooks/${token}/resume`,
        secret: derive('pertexo.callback.authentication'),
      };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const key of keys.values()) key.fill(0);
      keys.clear();
    },
  });
}
export type CallbackTokenKeys = ReturnType<typeof createCallbackTokenKeys>;

function isDevelopmentKey(encoded: string): boolean {
  const key = decodeApplicationKey(encoded);
  try {
    return key.toString('base64url') === CALLBACK_DEVELOPMENT_KEY;
  } finally {
    key.fill(0);
  }
}
