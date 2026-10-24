import {
  acceptForEachRun,
  acceptSerialForEachRun,
  acceptStructuredForEachRun,
} from '../../../../support/coordinator/runs.js';

export function acceptScenarioRun(
  input: Readonly<{
    structuredKind:
      Parameters<typeof acceptStructuredForEachRun>[0] | undefined;
    mode: string;
  }>,
) {
  if (input.structuredKind !== undefined)
    return acceptStructuredForEachRun(input.structuredKind);
  if (input.mode === 'serial_complete') return acceptSerialForEachRun();
  return acceptForEachRun();
}
