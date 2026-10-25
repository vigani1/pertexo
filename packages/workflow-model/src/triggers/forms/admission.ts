import { canonicalJson } from '../../values/json/canonical.js';

export function requiresFormAdmissionCheck(triggerType: string): boolean {
  return ['manual', 'api', 'replay'].includes(triggerType);
}

/** Interactive admission cannot invent a form's server-owned actor or time. */
export function formAdmissionRequirement(
  definitions: readonly Readonly<{ key: string; version: number }>[],
  triggerType: string,
): 'allow' | 'refuse' | 'match_source' {
  if (!requiresFormAdmissionCheck(triggerType)) return 'allow';
  if (
    !definitions.some(
      ({ key, version }) => key === 'core.form' && version === 1,
    )
  )
    return 'allow';
  return triggerType === 'replay' ? 'match_source' : 'refuse';
}

export function capturedFormReplayMatches(
  source:
    Readonly<{ workflowVersionId: string; inputRef: unknown }> | undefined,
  workflowVersionId: string,
  value: unknown,
): boolean {
  return (
    source?.workflowVersionId === workflowVersionId &&
    value !== undefined &&
    canonicalJson(source.inputRef) === canonicalJson(value)
  );
}
