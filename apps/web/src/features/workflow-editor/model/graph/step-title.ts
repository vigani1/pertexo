import { describeStep } from '@/features/catalog/presentation.public';
import type { WorkflowNode } from './scopes';

/** A step's label, or the human name of its type when it has none. */
export function stepTitle(node: Pick<WorkflowNode, 'label' | 'definition'>) {
  return node.label ?? describeStep(node.definition.key).name;
}
