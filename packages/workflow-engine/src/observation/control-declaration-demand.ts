import type { CallableValueWorkStop } from '@pertexo/workflow-model/workflow-call-contract';
import type { AttemptOutputReference } from '../types.js';

/** Framework-only selected original-byte material, not a supplied semantic summary. */
export type LoadCoordinatorControlDeclaration = (
  identity: Readonly<{
    sequence: number;
    attemptId: string;
    invocationKey: string;
  }>,
  signal: AbortSignal,
) => Promise<
  | Readonly<{
      kind: 'ready';
      material: Readonly<{
        sequence: number;
        attemptId: string;
        invocationKey: string;
        output: AttemptOutputReference;
        valueIdentity: Readonly<{
          reference:
            | Readonly<{ schemaVersion: 1; kind: 'inline' }>
            | Readonly<{
                schemaVersion: 1;
                kind: 'artifact';
                artifactId: string;
              }>;
          sha256: string;
          byteLength: number;
        }>;
        value: unknown;
      }>;
    }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>
>;
