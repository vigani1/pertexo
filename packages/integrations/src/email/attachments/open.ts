import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import {
  FileInputFailure,
  type NodeArtifactRuntime,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { failure } from '../failure.js';
import type { EmailAttachment } from '../validation.js';
import type { ResendAttachment } from './encode.js';
import { planAttachments, type PlannedAttachment } from './plan.js';

export type PreparedAttachments = Readonly<{
  planned: readonly PlannedAttachment[];
  files: readonly ResendAttachment[];
  spool: NonNullable<NodeArtifactRuntime['spool']>;
  release(): Promise<void>;
}>;

const NO_ATTACHMENTS: PreparedAttachments = Object.freeze({
  planned: [],
  files: [],
  spool: () => Promise.reject(new Error('No attachments to encode')),
  release: () => Promise.resolve(),
});

async function releaseAll(files: readonly ResendAttachment[]): Promise<void> {
  const released = await Promise.allSettled(
    files.map((file) => file.source.release()),
  );
  const failed = released.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

/**
 * Names, counts and verifies every file against its reference (workspace,
 * retention, length and SHA-256) before the connection is used or anything
 * is sent. A missing, unfinalized or foreign file fails as the usual
 * file-input problem.
 */
export async function prepareAttachments(
  attachments: readonly EmailAttachment[] | undefined,
  runtime: NodeExecutionRuntime,
  signal: AbortSignal,
): Promise<PreparedAttachments> {
  if (attachments === undefined || attachments.length === 0)
    return NO_ATTACHMENTS;
  const files: ResendAttachment[] = [];
  try {
    const planned = planAttachments(attachments);
    const artifacts = runtime.artifacts;
    const openVerified = artifacts?.openVerified?.bind(artifacts);
    const spool = artifacts?.spool?.bind(artifacts);
    if (openVerified === undefined || spool === undefined)
      throw new FileInputFailure({ reason: 'file_unavailable' });
    for (const attachment of planned) {
      signal.throwIfAborted();
      const source = await openVerified({
        reference: attachment.reference,
        maxBytes: FILE_PAGE_LIMITS.fileBytes,
        signal,
      });
      files.push({
        filename: attachment.filename,
        contentType: attachment.contentType,
        source,
      });
    }
    return Object.freeze({
      planned,
      files,
      spool,
      release: () => releaseAll(files),
    });
  } catch (error: unknown) {
    await releaseAll(files);
    // After an earlier unresolved dispatch the files can't be resent, so the
    // outcome stays unknown.
    if (runtime.providerDispatchUnresolved ?? false)
      throw failure('outcome_unknown', 'provider', {
        possiblyDispatched: true,
      });
    if (signal.aborted)
      throw failure('canceled', 'canceled', { possiblyDispatched: false });
    throw error;
  }
}
