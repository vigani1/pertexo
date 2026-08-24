import { z } from 'zod';

import { CORE_PARALLEL_BRANCH_PORT_SCHEMA } from '../parallel/validation.js';

const joinPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('any') }).strict(),
  z
    .object({
      kind: z.literal('count'),
      count: z.number().int().min(1).max(16),
    })
    .strict(),
]);
const branchLedgerEntrySchema = z
  .object({
    disposition: z.enum([
      'pending',
      'arrived',
      'skipped',
      'missing',
      'failed',
      'canceled',
    ]),
    output: z.unknown().optional(),
  })
  .strict();

export const CORE_MERGE_CONFIG_SCHEMA = z
  .object({
    parallelNodeId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u),
    policy: joinPolicySchema,
  })
  .strict();
export const CORE_MERGE_INPUT_SCHEMA = z
  .object({
    ledger: z.partialRecord(
      CORE_PARALLEL_BRANCH_PORT_SCHEMA,
      branchLedgerEntrySchema,
    ),
    selectedBranchIds: z.array(CORE_PARALLEL_BRANCH_PORT_SCHEMA).max(16),
  })
  .strict();
export const CORE_MERGE_OUTPUT_SCHEMA = CORE_MERGE_INPUT_SCHEMA;
