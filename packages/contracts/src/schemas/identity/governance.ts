import {
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
} from '@pertexo/workflow-model';
export { AUDIT_RETENTION_MAX_DAYS, AUDIT_RETENTION_MIN_DAYS };
import { z } from 'zod';

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9._:-]*$/u)
  .max(128);
const auditFilterShape = {
  person: z.string().trim().min(1).max(256).optional(),
  actorId: z.uuid().optional(),
  action: identifier.optional(),
  targetType: identifier.max(64).optional(),
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
    after: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(dateRange, { message: 'The end must be after the start.' });
export const auditEventSchema = z
  .object({
    id: z.uuid(),
    actorId: z.uuid().nullable(),
    actorName: z.string().max(256).nullable(),
    action: identifier,
    targetType: identifier.max(64),
    targetId: z.uuid().nullable(),
    occurredAt: z.iso.datetime(),
    metadata: z.record(
      z.string(),
      z.union([
        z.string().max(256),
        z.number(),
        z.boolean(),
        z.array(z.string().max(128)).max(100),
      ]),
    ),
  })
  .strict();
export const auditPageSchema = z
  .object({
    items: z.array(auditEventSchema).max(100),
    nextCursor: z.string().max(512).nullable(),
  })
  .strict();

export const auditRetentionSchema = z
  .number()
  .int()
  .min(AUDIT_RETENTION_MIN_DAYS)
  .max(AUDIT_RETENTION_MAX_DAYS);
export const governanceSettingsSchema = z
  .object({
    revision: z.number().int().positive(),
    auditRetentionDays: auditRetentionSchema,
    requirePublishApproval: z.boolean().default(false),
  })
  .strict();
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
