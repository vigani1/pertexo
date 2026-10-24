import { describeStep } from '@/features/catalog/presentation.public';
import { useId } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { diffWorkflowGraphs } from '@/features/workflows/comparison.public';
import { LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Disclosure } from '@/components/ui/disclosure';

export function ReviewCandidate({
  graph,
  liveGraph,
}: Readonly<{
  graph: WorkflowGraphContract;
  liveGraph: WorkflowGraphContract | null;
}>) {
  const id = useId();
  const before = liveGraph ?? { nodes: [], edges: [], settings: {} };
  const diff = diffWorkflowGraphs(before, graph);
  return (
    <section
      aria-label="Reviewed draft"
      className="flex min-w-0 flex-col gap-4"
    >
      <h2 className="font-semibold">Exactly what will be published</h2>
      <p className="text-sm text-muted-foreground">
        {liveGraph === null ? 'First publication. ' : ''}
        {diff.added.length} steps added, {diff.changed.length} changed,{' '}
        {diff.removed.length} removed. {diff.linksAdded} links added,{' '}
        {diff.linksRemoved} removed. {diff.notes.length} notes changed.
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
        {graph.nodes.map((node) => (
          <li key={node.id} className="py-3">
            <p className="font-medium [overflow-wrap:anywhere]">
              {node.label ?? describeStep(node.definition.key).name}
            </p>
            <p className="text-xs text-muted-foreground">
              {node.definition.key} · v{node.definition.version}
              {(node.disabled ?? false) ? ' · disabled' : ''}
            </p>
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
