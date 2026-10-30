import { isApiError } from '@/lib/api/error';

export const RUN_COMMAND_EXPIRED_MESSAGE =
  'The original request’s 24-hour retry window has ended. Check run history before starting another run.';

/** Admission refusal is shared by manual starts, replay and step recovery. */
export function runAdmissionError(error: unknown): string | undefined {
  return isApiError(error) && error.problem?.code === 'workflow.already_running'
    ? 'This workflow is already running. Try again shortly.'
    : undefined;
}
