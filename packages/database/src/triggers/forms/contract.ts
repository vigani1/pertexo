import type {
  FormAccess,
  FormAccessRequest,
  FormSchemaResponse,
  FormSubmissionRequest,
  FormSubmissionResponse,
  CoordinatedEventHistory,
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
export interface FormStore {
  discover(
    input: Readonly<{
      publicId: string;
      capability: string;
      signal?: AbortSignal;
    }>,
  ): Promise<PublicFormGrant>;
  read(input: FormScope, grant?: PublicFormGrant): Promise<FormSchemaResponse>;
  submit(
    input: FormScope &
      FormSubmissionRequest &
      Readonly<{ idempotencyKey: string }>,
    grant?: PublicFormGrant,
  ): Promise<FormSubmissionResponse>;
  history(
    input: FormScope &
      Readonly<{
        actorId: string;
        limit: number;
        before?: string;
        beforeId?: string;
      }>,
  ): Promise<CoordinatedEventHistory>;
  access(input: FormScope & Readonly<{ actorId: string }>): Promise<FormAccess>;
  setAccess(
    input: FormScope &
      FormAccessRequest &
      Readonly<{ actorId: string; idempotencyKey: string }>,
  ): Promise<FormAccess>;
  close(): Promise<void>;
}
export class FormUnavailableError extends Error {
  override readonly name = 'FormUnavailableError';
}
export class FormChangedError extends Error {
  override readonly name = 'FormChangedError';
}
export class FormAccessConflictError extends Error {
  override readonly name = 'FormAccessConflictError';
}
