import { isDeepStrictEqual } from 'node:util';

import type { WorkflowNode } from '@pertexo/workflow-model';

import {
  PLATFORM_NODE_CATALOG,
  resolvePlatformNodeDefinition,
} from './catalog.js';
import { validateRegisteredCuratedTemplateSetup } from './curated-template-policy.js';
import { PortableConnectionSlotPolicyError } from './node-catalog.errors.js';

import { findConnectionSlot } from './integration-modules.js';

/** Registered config/credential policy, without invoking an executor or secret store. */
export function platformPortableDefinitionPolicy() {
  const definitions = PLATFORM_NODE_CATALOG.definitions.map((manifest) => {
    const registration = resolvePlatformNodeDefinition(manifest.definition);
    const slots = manifest.connectionRequirements.map((slot) => {
      const policy = findConnectionSlot(slot);
      if (policy === undefined) throw new PortableConnectionSlotPolicyError();
      return Object.freeze({
        slot,
        providerKey: policy.providerKey,
        authType: policy.authType,
        acceptedAuthTypes: policy.acceptedAuthTypes,
        optional: (manifest.optionalConnections ?? []).includes(slot),
      });
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
  const registrations = new Map(
    PLATFORM_NODE_CATALOG.definitions.map((manifest) => [
      `${manifest.definition.key}@${String(manifest.definition.version)}`,
      resolvePlatformNodeDefinition(manifest.definition),
    ]),
  );
  return Object.freeze({
    definitions: Object.freeze(definitions),
    // The check a run makes, not validateConfig's: a default is fine here. A step
    // not in the catalog has its own refusal.
    acceptsStepConfig: (node: WorkflowNode): boolean => {
      const registration = registrations.get(
        `${node.definition.key}@${String(node.definition.version)}`,
      );
      return registration?.configSchema.safeParse(node.config).success ?? true;
    },
    // Template setup checks inputs too; validateConfig stays config-only.
    validateTemplateSetup: validateRegisteredCuratedTemplateSetup,
  });
}
