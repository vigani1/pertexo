import { isRecord, isHumanTaskDefinition } from '@pertexo/workflow-model';
import type { ExecutionNode } from '../compilation/foundation.js';
import {
  configuredBranchOutputPorts,
  configuredParallelOutputPorts,
} from '../transition/scheduling/readiness.js';
import type { WorkflowTestPins } from './policy.js';

/** Branch selection is engine control data even when its output was pasted. */
export function validWorkflowTestPin(
  node: ExecutionNode,
  pin: WorkflowTestPins[string],
): boolean {
  const branches = configuredBranchOutputPorts(node);
  const parallel = configuredParallelOutputPorts(node);
  if (branches === undefined && parallel === undefined) return true;
  const output = pin.output;
  if (!isRecord(output)) return false;
  if (branches !== undefined)
    return (
      typeof output.selectedPort === 'string' &&
      branches.includes(output.selectedPort) &&
      (isHumanTaskDefinition(node.definition) ||
        Object.keys(output).length === 1)
    );
  const selected = output.branchIds;
  return (
    Array.isArray(selected) &&
    Object.keys(output).length === 1 &&
    selected.length === parallel?.length &&
    selected.every((port, index) => port === parallel[index])
  );
}
