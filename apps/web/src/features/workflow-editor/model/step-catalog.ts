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
 * Placeable steps grouped under human headings and filtered by a search over
 * names, descriptions and keys. Unavailable definitions are left out.
 */
export function groupStepChoices(
  definitions: readonly NodeDefinitionCatalogItem[],
  query: string,
): readonly StepChoiceGroup[] {
  const needle = query.trim().toLowerCase();
  const choices = definitions.flatMap((definition): StepChoice[] => {
    if (!definition.available) return [];
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
  });
  return stepGroups.flatMap((group) => {
    const grouped = choices.filter(
      (choice) => choice.definition.family === group.family,
    );
    return grouped.length === 0 ? [] : [{ ...group, choices: grouped }];
  });
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
