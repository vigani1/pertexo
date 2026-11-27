import { useStepDescriptions } from '@/features/catalog/public';
import { useId } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { graphSteps } from '@/features/workflow-drafts/public';
import { diffWorkflowGraphs } from '@/features/workflows/public';
import { LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Disclosure } from '@/components/ui/disclosure';
import { formatCount } from '@/lib/format/count';
import {
  AGENT_SLACK_CONNECTION_SLOT,
  agentToolsAllowedWithoutApproval,
} from '@pertexo/workflow-model';
import { StatusMark } from '@/components/patterns/status/status-mark';
import type { DescribeStep } from '@/features/catalog/public';

export function ReviewCandidate({
  graph,
  liveGraph,
}: Readonly<{
  graph: WorkflowGraphContract;
  liveGraph: WorkflowGraphContract | null;
}>) {
  const describeStep = useStepDescriptions();
  const id = useId();
  const before = liveGraph ?? { nodes: [], edges: [], settings: {} };
  const diff = diffWorkflowGraphs(before, graph, describeStep);
  return (
    <section
      aria-label="Reviewed draft"
      className="flex min-w-0 flex-col gap-4"
    >
      <h2 className="font-semibold">Exactly what will be published</h2>
      <p className="text-sm text-muted-foreground">
        {liveGraph === null ? 'First publication. ' : ''}
        {formatCount(diff.added.length, 'step')} added, {diff.changed.length}{' '}
        changed, {diff.removed.length} removed.{' '}
        {formatCount(diff.linksAdded, 'link')} added, {diff.linksRemoved}{' '}
        removed. {formatCount(diff.notes.length, 'note')} changed.
      </p>
      <ul
        className="list-inside list-disc text-sm"
        aria-label="Definition changes"
      >
        {diff.lines.map((line) => (
          <li key={`${line.target}:${line.id}`}>
            {line.label}
            {line.detail === undefined ? '' : ` · ${line.detail}`}
          </li>
        ))}
      </ul>
      <ol className="divide-y divide-border">
        {graphSteps(graph).map(({ node, inside }) => (
          <li key={node.id} className={inside === null ? 'py-3' : 'py-3 pl-6'}>
            <p className="font-medium [overflow-wrap:anywhere]">
              {node.label ?? describeStep(node.definition).name}
            </p>
            <p className="text-xs text-muted-foreground">
              {node.definition.key} · v{node.definition.version}
              {(node.disabled ?? false) ? ' · disabled' : ''}
              {inside === null
                ? ''
                : ` · inside ${inside.label ?? describeStep(inside.definition).name}`}
            </p>
            <AgentWriteAllowance node={node} describe={describeStep} />
            <Disclosure summary="Setup and mappings" className="mt-2">
              <pre
                className="max-h-80 overflow-auto rounded-md border border-border p-3 text-xs"
                tabIndex={0}
              >
                {JSON.stringify(
                  {
                    config: node.config,
                    retry: node.retry,
                    inputMappings: node.inputMappings,
                    connectionRefs: node.connectionRefs,
                    structured: node.structured,
                  },
                  null,
                  2,
                )}
              </pre>
            </Disclosure>
          </li>
        ))}
      </ol>
      <Disclosure summary="Complete draft and live version">
        <div className="flex min-w-0 flex-col gap-4">
          <LabelledField
            id={`${id}-candidate`}
            label="Reviewed draft JSON"
            description="Read only; includes all steps, links and workflow settings without truncation."
          >
            {(control) => (
              <Textarea
                {...control}
                className="font-mono text-base md:text-xs"
                rows={12}
                readOnly
                value={JSON.stringify(graph, null, 2)}
              />
            )}
          </LabelledField>
          {liveGraph === null ? null : (
            <LabelledField id={`${id}-live`} label="Current live version JSON">
              {(control) => (
                <Textarea
                  {...control}
                  className="font-mono text-base md:text-xs"
                  rows={12}
                  readOnly
                  value={JSON.stringify(liveGraph, null, 2)}
                />
              )}
            </LabelledField>
          )}
        </div>
      </Disclosure>
    </section>
  );
}

function AgentWriteAllowance({
  node,
  describe,
}: Readonly<{
  node: WorkflowGraphContract['nodes'][number];
  describe: DescribeStep;
}>) {
  if (node.disabled) return null;
  return agentToolsAllowedWithoutApproval(node).map((tool) => (
    <div
      key={tool.alias}
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
    >
      <StatusMark tone="attention">Allowed without approval</StatusMark>
      <span>
        {describe(tool.definition).name} · {tool.alias}
      </span>
      <span className="basis-full text-muted-foreground">
        {agentWriteTarget(
          tool.config,
          node.connectionRefs[AGENT_SLACK_CONNECTION_SLOT],
        )}
      </span>
    </div>
  ));
}

function agentWriteTarget(
  config: ReturnType<typeof agentToolsAllowedWithoutApproval>[number]['config'],
  slackConnection: string | undefined,
) {
  if ('table' in config) return `Workspace table ${config.table}`;
  if ('target' in config)
    return `Callable workflow ${config.target.workflowId} · version ${config.target.workflowVersionId}`;
  return `Slack channel ${config.channelId} · connection ${slackConnection ?? ''}`;
}
