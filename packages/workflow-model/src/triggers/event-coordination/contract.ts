import { z } from 'zod';
import { isWorkflowTriggerDefinition } from '../../graph/triggers.js';
import { parseJsonPath } from '../../values/json/path.js';
import {
  runInputValueSourceSchema,
  expressionValueSourceSchema,
} from '../../values/mapping/contract.js';

export const EVENT_COORDINATION_LIMITS = Object.freeze({
  keyBytes: 512,
  activeKeys: 10_000,
  pendingEvents: 1_000,
  pendingBytes: 64 * 1024 * 1024,
  pendingMillis: 24 * 60 * 60_000,
  capacityWaitMillis: 15 * 60_000,
  historyDays: 90,
});
export const eventCoordinationKeySchema = z.discriminatedUnion('kind', [
  runInputValueSourceSchema.extend({
    path: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (path) => parseJsonPath(path) !== undefined,
        'Use a valid event input path.',
      ),
  }),
  expressionValueSourceSchema.extend({
    expression: z.string().min(1).max(16_384),
  }),
]);
const keyed = z.object({ key: eventCoordinationKeySchema });
export const eventCoordinationPolicySchema = z.discriminatedUnion('mode', [
  keyed
    .extend({
      mode: z.literal('deduplicate'),
      windowSeconds: z.number().int().min(1).max(604_800).default(86_400),
    })
    .strict(),
  keyed
    .extend({
      mode: z.literal('debounce'),
      quietSeconds: z.number().int().min(1).max(3_600).default(5),
    })
    .strict(),
  keyed
    .extend({
      mode: z.literal('throttle'),
      windowSeconds: z.number().int().min(1).max(86_400).default(60),
      limit: z.number().int().min(1).max(1_000).default(1),
      onExcess: z.enum(['skip', 'delay']).default('skip'),
    })
    .strict(),
]);
export type EventCoordinationPolicy = z.output<
  typeof eventCoordinationPolicySchema
>;
export const eventCoordinationOutcomeSchema = z.enum([
  'deduplicated',
  'debounced',
  'throttled',
  'refused',
]);
export const eventCoordinationStatusSchema = z.enum([
  'pending',
  'started',
  'skipped',
  'coalesced',
  'refused',
]);
export const eventCoordinationReasonSchema = z.enum([
  'duplicate_key',
  'newer_event',
  'throttle_limit',
  'invalid_key',
  'coordination_full',
  'coordination_timeout',
  'queue_full',
  'concurrency_limit',
  'workflow_unavailable',
  'publication_changed',
  'endpoint_disabled',
]);
export const eventCoordinationReceiptSchema = z
  .object({
    coordinated: z.literal(true),
    eventId: z.uuid(),
    outcome: eventCoordinationOutcomeSchema,
    status: z.enum(['pending', 'skipped', 'refused']),
    reason: eventCoordinationReasonSchema.nullable(),
  })
  .strict();
export type EventCoordinationReceipt = z.output<
  typeof eventCoordinationReceiptSchema
>;
/**
 * A server with no room for this event: nothing is kept, and only the sender can
 * save it, by trying again. A refusal for the sender's own mistake stays final.
 */
export function asksSenderToRetry(receipt: EventCoordinationReceipt): boolean {
  return receipt.status === 'refused' && receipt.reason === 'coordination_full';
}
export type EventCoordinationStatus = z.output<
  typeof eventCoordinationStatusSchema
>;
export type EventCoordinationReason = z.output<
  typeof eventCoordinationReasonSchema
>;
export function isEventCoordinationTrigger(
  definition: Readonly<{ key: string; version: number }>,
): boolean {
  return (
    isWorkflowTriggerDefinition(definition) &&
    (definition.key === 'core.webhook' || definition.key === 'core.form')
  );
}
