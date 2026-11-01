import type {
  parseFormValues,
  FormValuesInvalidError,
} from '@pertexo/workflow-model';
import type { PreparedEventCoordination } from '../coordination/contract.js';

import type {
  FormAccessRequest,
  FormSubmissionRequest,
} from '@pertexo/contracts';
export type FormScope = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId?: string;
  signal?: AbortSignal;
  requestId?: string;
  traceId?: string;
}>;
export type PublicFormGrant = Readonly<{
  workspaceId: string;
  workflowId: string;
  publicId: string;
  nodeId: string;
  capabilityHash: string;
}>;
export type DiscoverFormInput = Readonly<{
  publicId: string;
  capability: string;
  signal?: AbortSignal;
}>;
export type SubmitFormInput = FormScope &
  FormSubmissionRequest &
  Readonly<{ idempotencyKey: string; uploadSession?: string }>;
export type FormHistoryInput = FormScope &
  Readonly<{
    actorId: string;
    limit: number;
    before?: string;
    beforeId?: string;
  }>;
export type ReadFormAccessInput = FormScope & Readonly<{ actorId: string }>;
export type SetFormAccessInput = FormScope &
  FormAccessRequest &
  Readonly<{ actorId: string; idempotencyKey: string }>;

export type PreparedFormEvent =
  | Readonly<{ versionId: string; error: FormValuesInvalidError }>
  | Readonly<{
      versionId: string;
      input: Readonly<{
        values: ReturnType<typeof parseFormValues>;
        submittedBy: string | null;
        submittedAt: string;
      }>;
      /** The responder's uploads the values took, marked sent on acceptance. */
      uploadIds: readonly string[];
      coordination?: PreparedEventCoordination;
    }>;
