import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  describeStepChange,
  diffWorkflowGraphs as diffGraphs,
} from '@/features/workflow-drafts/public';
import { stepLabel } from '../shape';
import { canonicalizeJson } from '@/lib/canonical-json';

export type VersionStepChange = Readonly<{
  id: string;
  label: string;
  /** For a changed step, what changed: "setup, inputs". */
  detail?: string;
}>;

export type VersionDiff = Readonly<{
  added: readonly VersionStepChange[];
  removed: readonly VersionStepChange[];
  changed: readonly VersionStepChange[];
  linksChanged: boolean;
  contractChanged: boolean;
  settingsChanged: boolean;
}>;

/**
 * What changed from one version to the next, by step: added, removed, or
 * changed and how (setup, inputs, connection, name). Moving a step on the
 * canvas is not a change. Built on the drafts' graph diff, so every compare
 * in the app agrees.
 */
export function diffWorkflowGraphs(
  previous: WorkflowGraphContract,
  current: WorkflowGraphContract,
): VersionDiff {
  const diff = diffGraphs(previous, current, { ignoreLayout: true });
  const step = (node: WorkflowGraphContract['nodes'][number]) => ({
    id: node.id,
    label: stepLabel(node),
  });
  return {
    added: diff.added.map(step),
    removed: diff.removed.map(step),
    changed: diff.changed.map((change) => ({
      ...step(change.after),
      detail: describeStepChange(change.aspects),
    })),
    linksChanged: diff.linksAdded + diff.linksRemoved > 0,
    contractChanged:
      canonicalizeJson({ callable: previous.callable ?? null }) !==
      canonicalizeJson({ callable: current.callable ?? null }),
    settingsChanged:
      canonicalizeJson(previous.settings) !==
      canonicalizeJson(current.settings),
  };
}

export function isEmptyDiff(diff: VersionDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.linksChanged &&
    !diff.contractChanged &&
    !diff.settingsChanged
  );
}
