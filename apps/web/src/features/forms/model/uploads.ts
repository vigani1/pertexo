import { isApiError } from '@/lib/api/error';
import { retryAfterSeconds } from '@/lib/api/error-copy';

/**
 * A file's way through the upload: check, reserve, send, verify, then ready.
 * Only a ready file has an ID, and only a failed one a reason.
 */
export type UploadState = Readonly<
  | { phase: 'checking' | 'reserving' | 'sending' | 'verifying' }
  | { phase: 'ready'; uploadId: string }
  | {
      phase: 'failed';
      error: string;
      /** Whether the same file may simply be tried again. */
      retryable: boolean;
    }
>;

export type UploadRow = Readonly<{
  key: string;
  name: string;
  size: number;
}> &
  UploadState;

export type UploadPhase = UploadState['phase'];

export function phaseLabel(phase: UploadPhase): string {
  switch (phase) {
    case 'checking':
      return 'Checking';
    case 'reserving':
      return 'Preparing';
    case 'sending':
      return 'Sending';
    case 'verifying':
      return 'Verifying';
    case 'ready':
      return 'Attached';
    case 'failed':
      return 'Not attached';
  }
}

const SERVER_WORDS = new Set([
  'form.file_type_not_allowed',
  'form.file_too_large',
  'form.upload_limit',
]);

/** Plain words for a failed upload, and whether retrying the same file can help. */
export function uploadFailure(
  error: unknown,
): Readonly<{ message: string; retryable: boolean }> {
  if (
    !isApiError(error) ||
    error.kind === 'network' ||
    error.kind === 'timeout'
  )
    return {
      message: 'The upload didn’t finish. Check your connection and retry.',
      retryable: true,
    };
  const code = error.problem?.code;
  if (code !== undefined && SERVER_WORDS.has(code))
    return {
      message: error.problem?.detail ?? 'This file can’t be attached here.',
      retryable: false,
    };
  if (code === 'form.upload_busy')
    return {
      message:
        error.problem?.detail ?? 'Too many uploads right now. Retry soon.',
      retryable: true,
    };
  if (code === 'form.changed')
    return {
      message: 'This form changed. Reload the page to attach files again.',
      retryable: false,
    };
  if (code === 'form.unavailable')
    return { message: 'This form is no longer available.', retryable: false };
  if (code === 'workspace.quota_exceeded')
    return {
      message:
        'This form can’t take more files right now. Ask the form’s owner to free up space.',
      retryable: true,
    };
  if (code === 'artifact.unavailable')
    return {
      message: 'File uploads aren’t available on this server right now.',
      retryable: true,
    };
  const seconds = retryAfterSeconds(error);
  if (error.status === 429)
    return {
      message: `Too many uploads at once. Retry in ${String(seconds ?? 30)} s.`,
      retryable: true,
    };
  return {
    message: 'The upload didn’t finish. Retry the same file.',
    retryable: true,
  };
}
