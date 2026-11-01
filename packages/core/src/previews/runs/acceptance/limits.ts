import { PreviewAdmissionDeniedError } from '../../errors.js';
import type { AcceptPreviewRunInput } from './contract.js';

export const PREVIEW_RETENTION_MAX_MS = 7 * 24 * 60 * 60 * 1_000;

export const PREVIEW_EXECUTION_TIMEOUT_MAX_MS = 5 * 60 * 1_000;

export function assertPreviewDeadlines(
  input: AcceptPreviewRunInput,
  now: Date,
): void {
  if (
    input.expiresAt.getTime() <= now.getTime() ||
    input.expiresAt.getTime() - now.getTime() > PREVIEW_RETENTION_MAX_MS
  )
    throw new PreviewAdmissionDeniedError('retention');
  const invalidDeadline =
    input.executionDeadlineAt.getTime() <= now.getTime() ||
    input.executionDeadlineAt.getTime() - now.getTime() >
      PREVIEW_EXECUTION_TIMEOUT_MAX_MS ||
    input.executionDeadlineAt.getTime() > input.expiresAt.getTime();
  if (invalidDeadline) throw new PreviewAdmissionDeniedError('deadline');
}
