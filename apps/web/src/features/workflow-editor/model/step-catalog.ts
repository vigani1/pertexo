import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { WaypointsIcon } from 'lucide-react';
import {
  describeStep,
  stepGroups,
  type StepFamily,
  type StepPresentation,
} from '@/features/catalog/presentation.public';
import { definitionIdentity } from './graph/adapter';

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
  /** A fixed name, or the members' names joined: "Switch · Parallel · Merge". */
  name: string;
  description: string;
  tile: Pick<StepPresentation, 'family' | 'icon'>;
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

type BundleRule = Readonly<{
  id: string;
  /** Its members, in this order. */
  keys: readonly string[];
  /** A fixed name; without one the members' names are joined. */
  name?: string;
  description: string;
  /** Its own tile; without one it takes its first member's. */
  tile?: Pick<StepPresentation, 'family' | 'icon'>;
  /** Where the first member would sit, or after the group's other rows. */
  place: 'first' | 'last';
}>;

/**
 * Related steps that share one row while browsing. The data table writes
 * follow the everyday actions, so a long list of table steps doesn't push
 * HTTP, email and Slack down the palette.
 */
const BUNDLES: readonly BundleRule[] = Object.freeze([
  {
    id: 'flows',
    keys: ['core.switch', 'core.parallel', 'core.merge'],
    description: 'Split and join branches',
    tile: { family: 'logic', icon: WaypointsIcon },
    place: 'first',
  },
  {
    id: 'table-writes',
    keys: [
      'core.table_insert',
      'core.table_update',
      'core.table_upsert',
      'core.table_delete',
    ],
    name: 'Data table rows',
    description: 'Insert, update, upsert or delete rows in a data table',
    place: 'last',
  },
]);

/**
 * One definition per step type, the way people pick steps: the catalog can
 * list several versions of a key, and a new step uses the highest one. The
 * result keeps the catalog's order of first appearance.
 */
export function placeableDefinitions(
  definitions: readonly NodeDefinitionCatalogItem[],
): readonly NodeDefinitionCatalogItem[] {
  const chosen = new Map<string, NodeDefinitionCatalogItem>();
  for (const candidate of definitions) {
    const key = candidate.definition.key;
    const current = chosen.get(key);
    if (
      current === undefined ||
      candidate.definition.version > current.definition.version
    )
      chosen.set(key, candidate);
  }
  return [...chosen.values()];
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
  const ranks = new Map<string, number>();
  const choices = placeableDefinitions(definitions).flatMap(
    (definition): StepChoice[] => {
      const step = describeStep(definition.definition.key, definition.family);
      const identity = definitionIdentity(
        definition.definition.key,
        definition.definition.version,
      );
      if (needle !== '') {
        const rank = matchRank(step, definition.definition.key, needle);
        if (rank === undefined) return [];
        ranks.set(identity, rank);
      }
      return [{ identity, definition, step }];
    },
  );
  const rankOf = (choice: StepChoice) => ranks.get(choice.identity) ?? 0;
  const groups = stepGroups.flatMap((group) => {
    const grouped = choices
      .filter((choice) => choice.definition.family === group.family)
      // A stable sort: equally good matches keep the catalog's order.
      .sort((left, right) => rankOf(left) - rankOf(right));
    if (grouped.length === 0) return [];
    const entries =
      needle === ''
        ? bundledEntries(grouped)
        : grouped.map((choice) => ({ kind: 'step' as const, choice }));
    return [{ ...group, choices: grouped, entries }];
  });
  // The group holding the best match comes first, so Enter adds it.
  return groups.sort(
    (left, right) =>
      Math.min(...left.choices.map(rankOf)) -
      Math.min(...right.choices.map(rankOf)),
  );
}

/**
 * How well a step matches a search: its exact name, then a name that starts
 * with the query, then any name match, then its description or key.
 */
function matchRank(
  step: Readonly<{ name: string; description: string }>,
  key: string,
  needle: string,
): number | undefined {
  const name = step.name.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  if (`${step.description} ${key}`.toLowerCase().includes(needle)) return 3;
  return undefined;
}

/**
 * A group's rows with each bundle's members folded into one row, where its
 * first member would sit or after the other rows. A bundle with fewer than
 * two members in the group leaves them as plain rows.
 */
function bundledEntries(
  choices: readonly StepChoice[],
): readonly StepListEntry[] {
  const bundles = BUNDLES.flatMap((rule) => {
    const members = rule.keys.flatMap((key) => {
      const member = choices.find(
        (choice) => choice.definition.definition.key === key,
      );
      return member === undefined ? [] : [member];
    });
    const [first] = members;
    if (first === undefined || members.length < 2) return [];
    const entry: StepListEntry = {
      kind: 'bundle',
      bundle: {
        id: rule.id,
        name:
          rule.name ?? members.map((member) => member.step.name).join(' · '),
        description: rule.description,
        tile: rule.tile ?? first.step,
        choices: members,
      },
    };
    return [{ rule, members: new Set(members), entry }];
  });
  const entries: StepListEntry[] = [];
  const placed = new Set<string>();
  for (const choice of choices) {
    const bundle = bundles.find((candidate) => candidate.members.has(choice));
    if (bundle === undefined) entries.push({ kind: 'step', choice });
    else if (bundle.rule.place === 'first' && !placed.has(bundle.rule.id)) {
      placed.add(bundle.rule.id);
      entries.push(bundle.entry);
    }
  }
  for (const bundle of bundles)
    if (bundle.rule.place === 'last') entries.push(bundle.entry);
  return entries;
}

/** A trigger a workflow can start with. */
export function isStartTrigger(definition: NodeDefinitionCatalogItem): boolean {
  return definition.family === 'trigger';
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
