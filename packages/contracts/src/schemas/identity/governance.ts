import { responseSchema } from '../shared/response-schema.js';
import {
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  DISPLAY_NAME_MAX_CHARACTERS,
} from '@pertexo/workflow-model';
export { AUDIT_RETENTION_MAX_DAYS, AUDIT_RETENTION_MIN_DAYS };
import { z } from 'zod';

const GOVERNANCE_BOUNDS = Object.freeze({
  identifierCharacters: 128,
  personCharacters: DISPLAY_NAME_MAX_CHARACTERS,
  targetTypeCharacters: 64,
  afterCharacters: 512,
  actorNameCharacters: DISPLAY_NAME_MAX_CHARACTERS,
  metadataCharacters: 256,
  metadataItemCharacters: 128,
  metadataItems: 100,
  auditPageItems: 100,
  nextCursorCharacters: 512,
  auditPageDefault: 50,
});

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9._:-]*$/u)
  .max(GOVERNANCE_BOUNDS.identifierCharacters);
const auditFilterShape = {
  person: z
    .string()
    .trim()
    .min(1)
    .max(GOVERNANCE_BOUNDS.personCharacters)
    .optional(),
  actorId: z.uuid().optional(),
  action: identifier.optional(),
  targetType: identifier.max(GOVERNANCE_BOUNDS.targetTypeCharacters).optional(),
  targetId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
};
const dateRange = (value: {
  from?: string | undefined;
  until?: string | undefined;
}) =>
  value.from === undefined ||
  value.until === undefined ||
  Date.parse(value.from) < Date.parse(value.until);
export const auditFilterSchema = z
  .object(auditFilterShape)
  .strict()
  .refine(dateRange, { message: 'The end must be after the start.' });
export const auditQuerySchema = z
  .object({
    ...auditFilterShape,
    after: z.string().max(GOVERNANCE_BOUNDS.afterCharacters).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(GOVERNANCE_BOUNDS.auditPageItems)
      .default(GOVERNANCE_BOUNDS.auditPageDefault),
  })
  .strict()
  .refine(dateRange, { message: 'The end must be after the start.' });
export const auditEventSchema = z
  .object({
    id: z.uuid(),
    actorId: z.uuid().nullable(),
    actorName: z.string().max(GOVERNANCE_BOUNDS.actorNameCharacters).nullable(),
    action: identifier,
    targetType: identifier.max(GOVERNANCE_BOUNDS.targetTypeCharacters),
    targetId: z.uuid().nullable(),
    occurredAt: z.iso.datetime(),
    metadata: z.record(
      z.string(),
      z.union([
        z.string().max(GOVERNANCE_BOUNDS.metadataCharacters),
        z.number(),
        z.boolean(),
        z
          .array(z.string().max(GOVERNANCE_BOUNDS.metadataItemCharacters))
          .max(GOVERNANCE_BOUNDS.metadataItems),
      ]),
    ),
  })
  .strict();
export const auditPageSchema = responseSchema(
  z
    .object({
      items: z.array(auditEventSchema).max(GOVERNANCE_BOUNDS.auditPageItems),
      nextCursor: z
        .string()
        .max(GOVERNANCE_BOUNDS.nextCursorCharacters)
        .nullable(),
    })
    .strict(),
);

export const auditRetentionSchema = z
  .number()
  .int()
  .min(AUDIT_RETENTION_MIN_DAYS)
  .max(AUDIT_RETENTION_MAX_DAYS);
export const governanceSettingsSchema = responseSchema(
  z
    .object({
      revision: z.number().int().positive(),
      auditRetentionDays: auditRetentionSchema,
      requirePublishApproval: z.boolean().default(false),
    })
    .strict(),
);
export const governanceUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    auditRetentionDays: auditRetentionSchema.optional(),
    requirePublishApproval: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.auditRetentionDays !== undefined ||
      value.requirePublishApproval !== undefined,
    { message: 'Choose a setting to change.' },
  );
export type AuditFilter = z.output<typeof auditFilterSchema>;
export type AuditQuery = z.output<typeof auditQuerySchema>;
export type AuditEvent = z.output<typeof auditEventSchema>;
export type AuditPage = z.output<typeof auditPageSchema>;
export type GovernanceSettings = z.output<typeof governanceSettingsSchema>;
