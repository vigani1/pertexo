import type { CommandIdentity } from '@pertexo/database/primitives';

import type {
  WorkflowGraph,
  CallableVersionSummary,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import type { z } from 'zod';
import type {
  PublishWorkflowInput,
  PublishWorkflowResult,
} from '../workflows/contract.js';
import type { executableSchema } from './input.js';

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
