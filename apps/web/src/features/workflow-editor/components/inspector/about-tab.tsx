import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/ui/copy-button';
import {
  describeConnectionRequirement,
  describeRetryBehaviour,
  describeStep,
  familyWord,
} from '@/features/catalog/presentation.public';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

/** What this step is, how it retries, what it touches, and its ID. */
export function AboutTab({
  node,
  definition,
}: Readonly<{
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
}>) {
  const step = describeStep(node.definition.key, definition?.family);
  return (
    <dl className="flex flex-col gap-4 text-sm">
      <Row term="Step type">
        <span className="font-medium">{step.name}</span>
        <span className="text-muted-foreground"> · {step.description}</span>
        <span className="mt-1 block font-mono text-xs text-subtle-foreground">
          {node.definition.key} · v{node.definition.version} ·{' '}
          {familyWord(step.family)}
        </span>
      </Row>
      {definition === undefined ? (
        <Row term="Catalog">
          This step type isn’t in the current catalog. Pertexo keeps it exactly
          as it is, but can’t publish it until it’s replaced.
        </Row>
      ) : (
        <>
          <Row term="Retries">
            {describeRetryBehaviour(definition.retryClass)}
          </Row>
          <Row term="Side effects">
            {sideEffects(definition, step.sideEffect)}
          </Row>
          {definition.connectionRequirements.length === 0 ? null : (
            <Row term="Needs">
              {definition.connectionRequirements
                .map(describeConnectionRequirement)
                .join(', ')}
            </Row>
          )}
        </>
      )}
      <Row term="Step ID">
        <CopyButton value={node.id} label="Copy step ID" display={node.id} />
      </Row>
    </dl>
  );
}

function Row({
  term,
  children,
}: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div>
      <dt className="text-xs font-semibold text-subtle-foreground">{term}</dt>
      <dd className="mt-1 leading-relaxed">{children}</dd>
    </div>
  );
}

function sideEffects(
  definition: NodeDefinitionCatalogItem,
  stepSentence: string | undefined,
): string {
  if (
    definition.resourceClass === 'cpu' &&
    definition.integration === undefined
  )
    return 'None. It works on data inside Pertexo.';
  return (
    stepSentence ??
    'It talks to an outside service, so a run can change things there.'
  );
}
