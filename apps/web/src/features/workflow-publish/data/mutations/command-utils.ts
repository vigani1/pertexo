import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { runAdmissionError } from '@/features/workflow-runs/commands.public';
import { describeCommandError } from '@/lib/api/error-copy';
import { sampleErrorDetail } from '../../model/testing/samples';
import { isApiError, UserFacingError, type ApiError } from '@/lib/api/error';

export function parseCommandJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new UserFacingError(message, { cause });
  }
}

/**
 * One sentence for a failed publish, run or test. `action` is a noun phrase
 * such as "publishing" or "this run", used as "Your role doesn’t allow …".
 */
export function commandErrorMessage(error: unknown, action: string): string {
  const admissionError = runAdmissionError(error);
  if (admissionError !== undefined) return admissionError;
  const sampleDetail = sampleErrorDetail(error);
  if (sampleDetail !== undefined) return sampleDetail;
  if (error instanceof UserFacingError) return error.message;
  if (
    isApiError(error) &&
    error.problem?.code === 'workflow.validation_unavailable'
  )
    return 'The workflow check is temporarily unavailable. Wait a moment and try again; no new version was published.';
  if (isUnconfirmedCommand(error))
    return `We couldn’t confirm whether ${action} went through. Retrying is safe: it won’t happen twice.`;
  if (
    isApiError(error) &&
    error.problem?.code === 'workflow.published_version_conflict'
  )
    return 'The published version changed. No run started. Review the current publication and create or load a new input case, then explicitly confirm a new run. The old case has not been rebound.';
  if (isApiError(error) && (error.status === 409 || error.status === 412))
    return 'The draft changed after it was saved. Check the latest changes and try again.';
  if (isApiError(error) && error.status === 422)
    return workflowIssueFailure(error, action);
  return describeCommandError(error, action);
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function workflowIssueFailure(error: ApiError, action: string): string {
  // A setup problem only compiling finds comes with its own sentence.
  const setup = error.problem?.errors?.find(
    (issue) => issue.code === 'executable_invalid',
  );
  const message =
    setup?.message ??
    (error.problem?.code === 'workflow.invalid'
      ? error.problem.errors?.[0]?.message
      : undefined) ??
    `${capitalize(action)} was stopped by issues in the workflow. Fix them and try again.`;
  return message;
}
