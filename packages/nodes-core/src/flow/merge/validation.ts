import {
  mergeConfigSchema,
  parallelBranchPortSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';

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

export const CORE_MERGE_CONFIG_SCHEMA = mergeConfigSchema;
export const CORE_MERGE_INPUT_SCHEMA = z
  .object({
    ledger: z
      .partialRecord(parallelBranchPortSchema, settledBranchLedgerEntrySchema)
      .refine((ledger) => Object.keys(ledger).length > 0, {
        message: 'Merge ledger must not be empty',
      }),
    selectedBranchIds: z.array(parallelBranchPortSchema).max(16),
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

/** What each selected branch produced, keyed by branch; bookkeeping stays internal. */
export const CORE_MERGE_OUTPUT_SCHEMA = z
  .object({
    branches: z.partialRecord(parallelBranchPortSchema, z.json()),
    selectedBranchIds: z.array(parallelBranchPortSchema).max(16),
  })
  .strict()
  .describe('Core merge node output');
