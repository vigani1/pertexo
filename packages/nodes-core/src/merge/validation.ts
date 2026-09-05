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
const settledBranchLedgerEntrySchema = z
  .object({
    disposition: z.enum([
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
export const CORE_MERGE_OUTPUT_SCHEMA = CORE_MERGE_INPUT_SCHEMA.describe(
  'Core merge node output',
);

export const CORE_MERGE_INPUT_SCHEMA_V2 = z
  .object({
    ledger: z
      .partialRecord(
        CORE_PARALLEL_BRANCH_PORT_SCHEMA,
        settledBranchLedgerEntrySchema,
      )
      .refine((ledger) => Object.keys(ledger).length > 0, {
        message: 'Merge ledger must not be empty',
      }),
    selectedBranchIds: z.array(CORE_PARALLEL_BRANCH_PORT_SCHEMA).max(16),
  })
  .strict()
  .superRefine(({ ledger, selectedBranchIds }, context) => {
    if (new Set(selectedBranchIds).size !== selectedBranchIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['selectedBranchIds'],
        message: 'Selected branch IDs must be unique',
      });
    }
    if (
      [...selectedBranchIds]
        .sort()
        .some((id, index) => id !== selectedBranchIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['selectedBranchIds'],
        message: 'Selected branch IDs must use canonical order',
      });
    }
    for (const branchId of selectedBranchIds) {
      if (ledger[branchId]?.disposition !== 'arrived') {
        context.addIssue({
          code: 'custom',
          path: ['selectedBranchIds'],
          message: 'Selected branches must be settled arrivals in the ledger',
        });
      }
    }
  });

export const CORE_MERGE_OUTPUT_SCHEMA_V2 = CORE_MERGE_INPUT_SCHEMA_V2.describe(
  'Core merge node output version 2',
);
