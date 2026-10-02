import {
  parsePersistedWorkflowCheckpoint,
  serializePersistedWorkflowCheckpoint,
  type PersistedWorkflowCheckpoint,
} from '../../compatibility/persisted-workflow-checkpoint.js';
import {
  parsePersistedWorkflowCheckpointV3,
  serializePersistedWorkflowCheckpointV3,
  type PersistedWorkflowCheckpointV3,
} from '../../compatibility/persisted-workflow-checkpoint-v3.js';

/** Internal coordinator union; retained public checkpoint codecs stay unchanged. */
export type CoordinatorCheckpoint =
  PersistedWorkflowCheckpoint | PersistedWorkflowCheckpointV3;

export function coordinatorExecutableFormat(
  row: Readonly<{
    graph_schema_version: number;
    executable_schema_version: number | null;
    executable_checksum: string;
  }>,
): 2 | 3 | undefined {
  if (
    row.graph_schema_version === 2 &&
    row.executable_schema_version === 3 &&
    /^wf:v3:sha256:[0-9a-f]{64}$/u.test(row.executable_checksum)
  )
    return 3;
  if (
    row.graph_schema_version === 1 &&
    row.executable_schema_version === 2 &&
    /^wf:v2:sha256:[0-9a-f]{64}$/u.test(row.executable_checksum)
  )
    return 2;
  return undefined;
}

/** Format comes from the actual persisted executable, never an inferred upgrade. */
export function parseCoordinatorCheckpoint(
  value: unknown,
  executableSchemaVersion: number,
): CoordinatorCheckpoint {
  if (executableSchemaVersion === 3)
    return parsePersistedWorkflowCheckpointV3(value);
  if (executableSchemaVersion === 2)
    return parsePersistedWorkflowCheckpoint(value);
  throw new TypeError('Unsupported coordinator executable format');
}

export function serializeCoordinatorCheckpoint(
  checkpoint: CoordinatorCheckpoint,
): string {
  return checkpoint.schemaVersion === 3
    ? serializePersistedWorkflowCheckpointV3(checkpoint)
    : serializePersistedWorkflowCheckpoint(checkpoint);
}
