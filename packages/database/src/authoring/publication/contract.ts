import type { WorkflowAuthoringWriteContext } from '../workflows/context.js';
import type { CommandIdentity } from '../../platform/idempotency/contract.js';

import type {
  WorkflowGraph,
  CallableVersionSummary,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';

import { z } from 'zod';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';

import type {
  PublishWorkflowInput,
  PublishWorkflowResult,
} from '../workflows/contracts.js';

export const uuidSchema = z.uuid();

export const digestSchema = sha256HexSchema;

export const workflowDraftTagSchema = z
  .string()
  .regex(/^"draft\.[A-Za-z0-9_-]{43}"$/u);

export const providerKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

export const operationKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

export const executableSchema = z
  .object({
    checksum: z.string().regex(/^wf:sha256:[0-9a-f]{64}$/u),
    executableJson: z.record(z.string(), z.unknown()),
  })
  .strict();

export type WorkflowPublicationDependencies = Pick<
  WorkflowAuthoringWriteContext,
  'requireAuthor' | 'catalogs' | 'transact'
>;

export type PublicationCandidateInput = Omit<
  PublishWorkflowInput,
  'idempotencyKey' | 'requestHash' | 'commandCredentialId'
>;

export type PublicationClaim = Readonly<{
  command: CommandIdentity;
  replay: PublishWorkflowResult | null;
  workflowId: string;
}>;

export type CompiledPublication = Readonly<{
  versionId: string;
  calls: CallableVersionSummary['calls'];
  checksum: string;
  definitionCatalog: WorkflowDefinitionCatalog;
  executable: z.output<typeof executableSchema>;
  graph: WorkflowGraph;
}>;

/** A retry gets back the version its first attempt published. */
export const storedPublicationSchema = z
  .object({ versionId: uuidSchema, reused: z.boolean() })
  .strict();
