import { supportsStepRetrySettings } from '@pertexo/workflow-model';
import { describeStepRetrySettings } from '../../../model/inspector/retries/draft';
import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/ui/copy-button';
import {
  outputFieldsOf,
  type OutputField,
} from '../../../model/inspector/input-mappings/draft';
import {
  describeConnectionRequirement,
  describeRetryBehaviour,
  describeStep,
  familyWord,
  requiredConnections,
} from '@/features/catalog/presentation.public';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

/**
 * What this step is, what it returns, how it retries, what it touches, and
 * its ID.
 */
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
          <Row term="Returns">
            <ReturnedFields
              fields={outputFieldsOf(
                definition.outputSchema,
                node,
                definition.outputVariant,
              )}
            />
          </Row>
          <Row term="Retries">
            {supportsStepRetrySettings(node.definition) ? (
              <p>{describeStepRetrySettings(node.retry)}</p>
            ) : null}
            <p className="text-muted-foreground">
              {describeRetryBehaviour(definition.retryClass)}
            </p>
          </Row>
          <Row term="Side effects">
            {sideEffects(definition, step.sideEffect)}
          </Row>
          {requiredConnections(definition).length === 0 ? null : (
            <Row term="Needs">
              {requiredConnections(definition)
                .map(describeConnectionRequirement)
                .join(', ')}
            </Row>
          )}
          {(definition.optionalConnections ?? []).length === 0 ? null : (
            <Row term="Can use">
              {(definition.optionalConnections ?? [])
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

/** The fields a step's result has, which the steps after it can use. */
function ReturnedFields({
  fields,
}: Readonly<{ fields: readonly OutputField[] }>) {
  if (fields.length === 0)
    return (
      <span className="text-muted-foreground">
        No fixed fields. The Test tab shows a real result.
      </span>
    );
  return (
    <ul aria-label="Fields it returns" className="flex flex-wrap gap-1.5">
      {fields.map((field) => (
        <li
          key={field.key}
          className="rounded-sm border border-surface-ink/8 bg-surface-ink/[0.03] px-1.5 py-0.5 font-mono text-xs"
        >
          {field.key}
          {field.type === undefined ? null : (
            <span className="text-subtle-foreground"> · {field.type}</span>
          )}
        </li>
      ))}
    </ul>
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
