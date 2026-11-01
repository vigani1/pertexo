import type { PublicFormGrant } from '../../triggers/forms/contract.js';
import type { ArtifactRecord } from '../contract.js';
import type { ArtifactMetadataIdentity } from '../metadata.js';

/** Where a responder uploads: a published form (by link or as a member) or an input request. */
export type FormUploadTarget =
  | Readonly<{ kind: 'public_form'; grant: PublicFormGrant }>
  | Readonly<{
      kind: 'member_form';
      workspaceId: string;
      workflowId: string;
      actorId: string;
    }>
  | Readonly<{
      kind: 'input_request';
      workspaceId: string;
      taskId: string;
      actorId: string;
    }>;

/** One response in progress: a target plus the responder's random session token. */
export type FormUploadSession = Readonly<{
  target: FormUploadTarget;
  session: string;
  signal?: AbortSignal;
}>;

export type BeginFormUploadInput = FormUploadSession &
  Readonly<{
    /** The form version the responder sees; input requests have one fixed setup. */
    versionId?: string;
    fieldId: string;
    filename: string;
    byteLength: number;
    sha256: string;
    idempotencyKey: string;
  }>;

export type FormUpload = Readonly<{
  artifact: ArtifactRecord;
  filename: string;
}>;

export type DiscoverFormInput = Readonly<{
  publicId: string;
  capability: string;
  signal?: AbortSignal;
}>;

export type ReadFormUploadInput = FormUploadSession &
  Readonly<{ uploadId: string }>;

export type FinalizeFormUploadInput = ReadFormUploadInput &
  Readonly<{ expectedMetadata: ArtifactMetadataIdentity }>;
