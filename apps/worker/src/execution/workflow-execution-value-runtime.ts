import type { ArtifactStore } from '@pertexo/artifact-store';
import { prepareInlineWorkflowExecutionValueV3 } from '@pertexo/database/execution';

import type { ArtifactSpoolOperations } from './node-artifact-runtime.js';
import {
  createWorkflowExecutionValueCodec,
  type WorkflowExecutionValueCodecDependencies,
} from './workflow-execution-value-codec.js';
import {
  createWorkflowExecutionValueWriter,
  type WorkflowExecutionValueWriterPersistence,
} from './workflow-execution-value-writer.js';

/**
 * Framework composition, not a node capability or a persistence authority.
 * Persistence and object storage remain borrowed, externally owned dependencies.
 * Reservation callbacks, not retentionMillis, own durable expiry and quota.
 */
export function createWorkflowExecutionValueRuntime(
  input: Readonly<{
    persistence: WorkflowExecutionValueWriterPersistence &
      Pick<WorkflowExecutionValueCodecDependencies, 'reserve' | 'authorize'>;
    store: Pick<ArtifactStore, 'put' | 'getStream'>;
    retentionMillis: number;
    now?: () => Date;
    spoolDirectory?: string;
    spoolOperations?: ArtifactSpoolOperations;
  }>,
) {
  return createWorkflowExecutionValueCodec({
    // These policies are owned here, rather than selected by each producer.
    chooseInline: prepareInlineWorkflowExecutionValueV3,
    writeReserved: createWorkflowExecutionValueWriter(input),
    reserve: (request) => input.persistence.reserve(request),
    authorize: (request) => input.persistence.authorize(request),
    store: input.store,
  });
}
