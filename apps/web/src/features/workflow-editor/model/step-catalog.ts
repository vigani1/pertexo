import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import {
  describeStep,
  stepGroups,
  type StepFamily,
  type StepPresentation,
} from '@/features/catalog/presentation.public';
import { definitionIdentity } from './graph-adapter';

/** The drag payload an add-step item carries onto the canvas. */
export const STEP_DRAG_TYPE = 'application/x-pertexo-step';

export type StepChoice = Readonly<{
  identity: string;
  definition: NodeDefinitionCatalogItem;
  step: StepPresentation;
}>;

export type StepChoiceGroup = Readonly<{
  family: StepFamily;
  title: string;
  choices: readonly StepChoice[];
}>;

/**
 * One definition per step type, the way people pick steps: the catalog can
 * list several versions of a key, and a new step uses the highest version
 * that is available and publishable (or, when none can be published yet,
 * the highest available one). Unavailable keys are left out; the result
 * keeps the catalog's order of first appearance.
 */
export function placeableDefinitions(
  definitions: readonly NodeDefinitionCatalogItem[],
): readonly NodeDefinitionCatalogItem[] {
  const chosen = new Map<string, NodeDefinitionCatalogItem>();
  for (const candidate of definitions) {
    if (!candidate.available) continue;
    const key = candidate.definition.key;
    const current = chosen.get(key);
    if (current === undefined || preferVersion(candidate, current))
      chosen.set(key, candidate);
  }
  return [...chosen.values()];
}

function preferVersion(
  candidate: NodeDefinitionCatalogItem,
  current: NodeDefinitionCatalogItem,
): boolean {
  if (candidate.publishable !== current.publishable)
    return candidate.publishable;
  return candidate.definition.version > current.definition.version;
}

/**
 * Placeable steps grouped under human headings and filtered by a search over
 * names, descriptions and keys: one entry per step type.
 */
export function groupStepChoices(
  definitions: readonly NodeDefinitionCatalogItem[],
  query: string,
): readonly StepChoiceGroup[] {
  const needle = query.trim().toLowerCase();
  const choices = placeableDefinitions(definitions).flatMap(
    (definition): StepChoice[] => {
      const step = describeStep(definition.definition.key, definition.family);
      const haystack =
        `${step.name} ${step.description} ${definition.definition.key}`.toLowerCase();
      if (needle !== '' && !haystack.includes(needle)) return [];
      return [
        {
          identity: definitionIdentity(
            definition.definition.key,
            definition.definition.version,
          ),
          definition,
          step,
        },
      ];
    },
  );
  return stepGroups.flatMap((group) => {
    const grouped = choices.filter(
      (choice) => choice.definition.family === group.family,
    );
    return grouped.length === 0 ? [] : [{ ...group, choices: grouped }];
  });
}

/** A trigger a workflow can start with: placeable now and publishable later. */
export function isStartTrigger(definition: NodeDefinitionCatalogItem): boolean {
  return (
    definition.family === 'trigger' &&
    definition.available &&
    definition.publishable
  );
}

export function findDefinitionByIdentity(
  definitions: readonly NodeDefinitionCatalogItem[],
  identity: string,
): NodeDefinitionCatalogItem | undefined {
  return definitions.find(
    (definition) =>
      definitionIdentity(
        definition.definition.key,
        definition.definition.version,
      ) === identity,
  );
}
