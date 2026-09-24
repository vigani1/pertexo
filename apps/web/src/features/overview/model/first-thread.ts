import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';

// The "First thread" checklist for a new workspace. Each step is derived from
// real reads; a step the person's role can't check is left out rather than
// shown as undone.

export type FirstThreadDestination =
  | Readonly<{ to: 'workflows' }>
  | Readonly<{ to: 'workflow'; workflowId: string }>
  | Readonly<{ to: 'connections' }>
  | Readonly<{ to: 'alerts' }>
  | Readonly<{ to: 'team' }>;

export type FirstThreadStep = Readonly<{
  key: string;
  label: string;
  hint: string;
  done: boolean;
  destination: FirstThreadDestination;
}>;

/** What the person's reads tell us; undefined means "can't check". */
export type FirstThreadFacts = Readonly<{
  workflows?: readonly WorkflowSummary[];
  hasRun?: boolean;
  connectionCount?: number;
  destinationCount?: number;
  memberCount?: number;
}>;

function workflowSteps(
  workflows: readonly WorkflowSummary[],
  hasRun: boolean | undefined,
): FirstThreadStep[] {
  const [first] = workflows;
  const published = workflows.find(
    (workflow) => workflow.publishedVersionId !== null,
  );
  const toWorkflow = (workflow: WorkflowSummary | undefined) =>
    workflow === undefined
      ? ({ to: 'workflows' } as const)
      : ({ to: 'workflow', workflowId: workflow.id } as const);
  const steps: FirstThreadStep[] = [
    {
      key: 'create',
      label: 'Create a workflow',
      hint: 'Start from a blank canvas and add a trigger.',
      done: first !== undefined,
      destination: { to: 'workflows' },
    },
    {
      key: 'publish',
      label: 'Publish it',
      hint: 'Publishing freezes a version that triggers can run.',
      done: published !== undefined,
      destination: toWorkflow(first),
    },
  ];
  if (hasRun !== undefined)
    steps.push({
      key: 'run',
      label: 'Run it',
      hint: 'Start a run from Build, or let its trigger fire.',
      done: hasRun,
      destination: toWorkflow(published ?? first),
    });
  return steps;
}

export function firstThreadSteps(
  facts: FirstThreadFacts,
): readonly FirstThreadStep[] {
  const steps =
    facts.workflows === undefined
      ? []
      : workflowSteps(facts.workflows, facts.hasRun);
  if (facts.connectionCount !== undefined)
    steps.push({
      key: 'connection',
      label: 'Add a connection',
      hint: 'Connect Slack, email or an HTTP service your steps can use.',
      done: facts.connectionCount > 0,
      destination: { to: 'connections' },
    });
  if (facts.destinationCount !== undefined)
    steps.push({
      key: 'alert',
      label: 'Set a failure alert',
      hint: 'Hear about failed runs in Slack or by email.',
      done: facts.destinationCount > 0,
      destination: { to: 'alerts' },
    });
  if (facts.memberCount !== undefined)
    steps.push({
      key: 'invite',
      label: 'Invite a teammate',
      hint: 'Share the workspace with the people who run it with you.',
      done: facts.memberCount > 1,
      destination: { to: 'team' },
    });
  return steps;
}

/** A new workspace: nothing has run yet, or nothing exists to run. */
export function isNewWorkspace(facts: FirstThreadFacts): boolean {
  if (facts.hasRun !== undefined) return !facts.hasRun;
  return facts.workflows?.length === 0;
}
