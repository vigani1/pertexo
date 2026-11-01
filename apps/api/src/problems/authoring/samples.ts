import type { WorkflowStepSampleError } from '@pertexo/core/authoring';
import { applicationError } from '../../platform/http/index.js';

const messages: Readonly<Record<WorkflowStepSampleError['reason'], string>> = {
  changed: 'The pinned sample changed. Refresh it before trying again.',
  draft_changed:
    'The draft changed. Save and review the current step before trying again.',
  stale:
    'This pin is stale. Confirm it for the current setup, replace it, or remove it before testing the real step.',
  expired:
    'This pinned sample expired. Pin fresh data or remove it before testing the real step.',
  source_unavailable:
    'That sample source is unavailable, expired, or its setup changed. Capture a new request or choose a current successful step output.',
  file_output:
    'Pin JSON output only. Use Read file to turn a file into JSON first; file references cannot be pinned.',
  value_invalid:
    'Sample JSON exceeds the normal run-data limits or contains an invalid value. Keep it within 256 KB, depth 64 and 10,000 members.',
  limit_reached:
    'Pinned sample storage is full. Remove older samples before pinning more data.',
  step_unavailable:
    'This draft step no longer exists or its ID is ambiguous. Refresh the draft.',
};
export function sampleApplicationError(error: WorkflowStepSampleError) {
  return applicationError(sampleProblemCode(error.reason), {
    safeDetail: messages[error.reason],
    details: { reason: error.reason },
  });
}

function sampleProblemCode(reason: WorkflowStepSampleError['reason']) {
  if (reason === 'limit_reached') return 'workflow.sample_limit';
  if (reason === 'file_output' || reason === 'value_invalid')
    return 'workflow.sample_invalid';
  return 'workflow.sample_conflict';
}
