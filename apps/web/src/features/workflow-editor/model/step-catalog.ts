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

/**
 * Several related steps offered as one row that opens in place to its
 * members, the way the blueprint lists "Switch · Parallel · Merge".
 */
export type StepChoiceBundle = Readonly<{
  id: string;
  /** The members' names joined: "Switch · Parallel · Merge". */
  name: string;
  description: string;
  choices: readonly StepChoice[];
}>;

/** One row of the add-step list: a step, or a bundle of related steps. */
type StepListEntry =
  | Readonly<{ kind: 'step'; choice: StepChoice }>
  | Readonly<{ kind: 'bundle'; bundle: StepChoiceBundle }>;

export type StepChoiceGroup = Readonly<{
  family: StepFamily;
  title: string;
  choices: readonly StepChoice[];
  /**
   * The rows to show: while browsing, Switch, Parallel and Merge share one
   * row; a search lists every match on its own, so each is reached directly.
   */
  entries: readonly StepListEntry[];
}>;

/** Branching steps that share one row while browsing, in this order. */
const FLOW_BUNDLE = Object.freeze({
  id: 'flows',
  keys: Object.freeze(['core.switch', 'core.parallel', 'core.merge']),
  description: 'Split and join branches',
});

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
    if (grouped.length === 0) return [];
    const entries =
      needle === ''
        ? bundledEntries(grouped)
        : grouped.map((choice) => ({ kind: 'step' as const, choice }));
    return [{ ...group, choices: grouped, entries }];
  });
}

/**
 * A group's rows with the branching steps folded into one bundle row where
 * the first of them would sit. Fewer than two of them stay as plain rows.
 */
function bundledEntries(
  choices: readonly StepChoice[],
): readonly StepListEntry[] {
  const members = FLOW_BUNDLE.keys.flatMap((key) => {
    const member = choices.find(
      (choice) => choice.definition.definition.key === key,
    );
    return member === undefined ? [] : [member];
  });
  const bundled = new Set(members);
  const entries: StepListEntry[] = [];
  for (const choice of choices) {
    if (members.length < 2 || !bundled.has(choice)) {
      entries.push({ kind: 'step', choice });
      continue;
    }
    if (entries.some((entry) => entry.kind === 'bundle')) continue;
    entries.push({
      kind: 'bundle',
      bundle: {
        id: FLOW_BUNDLE.id,
        name: members.map((member) => member.step.name).join(' · '),
        description: FLOW_BUNDLE.description,
        choices: members,
      },
    });
  }
  return entries;
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

/** The first step a search lists, which Enter adds. */
export function firstStepChoice(
  definitions: readonly NodeDefinitionCatalogItem[],
  query: string,
): StepChoice | undefined {
  return groupStepChoices(definitions, query)[0]?.choices[0];
}
