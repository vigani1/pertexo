import './server-only.js';

import { validateRegisteredCuratedTemplateSetup } from './curated-template-policy.js';

import { isDeepStrictEqual } from 'node:util';
import { resolvePlatformNodeDefinition } from './definition-resolution.js';
import { PLATFORM_NODE_CATALOG } from './registry.js';

const CONNECTION_SLOT_POLICIES: Readonly<
  Record<string, Readonly<{ providerKey: string; authType: string }>>
> = Object.freeze({
  http_headers: { providerKey: 'http', authType: 'http_headers' },
  slack_bot_token: { providerKey: 'slack', authType: 'slack_bot_token' },
  resend_api_key: { providerKey: 'email', authType: 'resend_api_key' },
} as const);

/** Registered config/credential policy, without invoking an executor or secret store. */
export function platformPortableDefinitionPolicy() {
  const definitions = PLATFORM_NODE_CATALOG.definitions.map((manifest) => {
    const registration = resolvePlatformNodeDefinition(manifest.definition);
    const slots = manifest.connectionRequirements.map((slot) => {
      const policy = CONNECTION_SLOT_POLICIES[slot];
      if (policy === undefined)
        throw new Error('Portable connection slot policy is unavailable');
      return Object.freeze({ slot, ...policy });
    });
    return Object.freeze({
      ...manifest.definition,
      configVersion: manifest.configVersion,
      slots: Object.freeze(slots),
      validateConfig: (config: unknown): boolean => {
        const result = registration.configSchema.safeParse(config);
        // Graph admission uses null-prototype records; registered schemas can
        // return ordinary records. Compare their data, not that representation
        // difference, while still refusing defaults, trimming or other changes.
        return (
          result.success &&
          isDeepStrictEqual(
            structuredClone(result.data),
            structuredClone(config),
          )
        );
      },
    });
  });
  return Object.freeze({
    definitions: Object.freeze(definitions),
    // Template setup checks inputs too; validateConfig stays config-only.
    validateTemplateSetup: validateRegisteredCuratedTemplateSetup,
  });
}
