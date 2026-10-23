import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  describeStepChange,
  type NoteChange,
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

export type GraphChange = Readonly<{
  id: string;
  target: 'step' | 'note' | 'links' | 'settings' | 'callable';
  kind: 'added' | 'removed' | 'changed';
  label: string;
  detail?: string;
}>;

export type VersionDiff = Readonly<{
  lines: readonly GraphChange[];
  linksAdded: number;
  linksRemoved: number;
  layoutOnly: boolean;
  added: readonly VersionStepChange[];
  removed: readonly VersionStepChange[];
  changed: readonly VersionStepChange[];
  notes: readonly NoteChange[];
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
  const added = diff.added.map(step);
  const removed = diff.removed.map(step);
  const changed = diff.changed.map((change) => ({
    ...step(change.after),
    detail: describeStepChange(change.aspects),
  }));
  const contractChanged =
    canonicalizeJson(previous.callable ?? null) !==
    canonicalizeJson(current.callable ?? null);
  const settingsChanged =
    canonicalizeJson(previous.settings) !== canonicalizeJson(current.settings);
  const lines: GraphChange[] = [
    ...diff.notes.map((note) => ({ ...note, target: 'note' as const })),
    ...added.map((item) => ({
      ...item,
      target: 'step' as const,
      kind: 'added' as const,
    })),
    ...removed.map((item) => ({
      ...item,
      target: 'step' as const,
      kind: 'removed' as const,
    })),
    ...changed.map((item) => ({
      ...item,
      target: 'step' as const,
      kind: 'changed' as const,
    })),
    ...(diff.linksAdded + diff.linksRemoved > 0
      ? [
          {
            id: 'links',
            target: 'links' as const,
            kind: 'changed' as const,
            label: 'Links between steps',
            detail: `${String(diff.linksAdded)} added, ${String(diff.linksRemoved)} removed`,
          },
        ]
      : []),
    ...(settingsChanged
      ? [
          {
            id: 'settings',
            target: 'settings' as const,
            kind: 'changed' as const,
            label: 'Workflow execution settings',
          },
        ]
      : []),
    ...(contractChanged
      ? [
          {
            id: 'callable',
            target: 'callable' as const,
            kind: 'changed' as const,
            label: 'Input or callable contract',
          },
        ]
      : []),
  ];
  return {
    lines,
    linksAdded: diff.linksAdded,
    linksRemoved: diff.linksRemoved,
    layoutOnly:
      lines.length === 0 && diffGraphs(previous, current).changed.length > 0,
    added,
    removed,
    changed,
    notes: diff.notes,
    linksChanged: diff.linksAdded + diff.linksRemoved > 0,
    contractChanged,
    settingsChanged,
  };
}

export function isEmptyDiff(diff: VersionDiff): boolean {
  return diff.lines.length === 0;
}
