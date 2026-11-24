import {
  compareOrdinal,
  placeableDefinitions,
  workflowNodes,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { ListNodeDefinitionsService } from '../../catalog/index.js';

const CATALOG_CONTEXT_BYTES = 16_384;
const DESCRIPTION_CONTEXT_BYTES = 8_192;
const CATALOG_CONTEXT_ENTRIES = 8;
const CATALOG_LOOKUP_ENTRIES = 3;
const DESCRIPTION_MATCHES_PER_TERM = 2;
const GENERIC_SEARCH_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'could',
  'do',
  'field',
  'fields',
  'for',
  'from',
  'in',
  'input',
  'is',
  'it',
  'myself',
  'of',
  'on',
  'or',
  'other',
  'run',
  'step',
  'steps',
  'the',
  'then',
  'this',
  'to',
  'trigger',
  'value',
  'values',
  'want',
  'when',
  'with',
  'workflow',
  'you',
]);
type CatalogEntry = ReturnType<
  ListNodeDefinitionsService['execute']
>['items'][number];

export function proposalCatalog(
  catalog: ListNodeDefinitionsService,
  request: string,
  draft: WorkflowGraph,
  seen?: ReadonlySet<string>,
) {
  const { items, codeSettings } = catalog.execute();
  const terms = words(request);
  const phrase = ` ${terms.join(' ')} `;
  const existing = new Set<string>();
  const referenced = new Set<string>();
  const draftLabelTerms = new Set<string>();
  for (const { definition, label } of workflowNodes(draft)) {
    const id = identity(definition);
    existing.add(id);
    const name = words(label ?? '');
    if (name.length === 0 || !phrase.includes(` ${name.join(' ')} `)) continue;
    referenced.add(id);
    for (const term of name) draftLabelTerms.add(term);
  }
  const current = new Set(
    placeableDefinitions(items, codeSettings).map(({ definition }) =>
      identity(definition),
    ),
  );
  const query = new Set(
    terms.filter(
      (term) => !GENERIC_SEARCH_WORDS.has(term) && !draftLabelTerms.has(term),
    ),
  );
  const ranked = items.flatMap((item) => {
    const id = identity(item.definition);
    const inDraft = existing.has(id);
    if (seen?.has(id) || (!inDraft && !current.has(id))) return [];
    const names = [item.presentation?.name, item.display?.name].flatMap(
      (name) => (name === undefined ? [] : [words(name)]),
    );
    const key = words(item.definition.key);
    const exact = [...names, key].some(
      (name) => name.length > 0 && phrase.includes(` ${name.join(' ')} `),
    );
    const identityMatches = overlap(query, [
      ...names.flat(),
      ...key,
      ...words(item.integration?.operationKey ?? ''),
    ]);
    const familyMatches = overlap(query, words(item.family));
    const descriptionMatches = matchingTerms(
      query,
      words(item.display?.description ?? ''),
    );
    if (
      (!inDraft || seen !== undefined) &&
      !exact &&
      identityMatches + familyMatches + descriptionMatches.length === 0
    )
      return [];
    const entry = projectEntry(item, inDraft && !current.has(id));
    return [
      {
        entry,
        entryBytes: Buffer.byteLength(JSON.stringify(entry)),
        inDraft,
        referenced: referenced.has(id),
        exact,
        identityMatches,
        familyMatches,
        descriptionMatches,
      },
    ];
  });
  ranked.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      Number(b.referenced) - Number(a.referenced) ||
      b.identityMatches - a.identityMatches ||
      b.descriptionMatches.length - a.descriptionMatches.length ||
      b.familyMatches - a.familyMatches ||
      Number(b.inDraft) - Number(a.inDraft) ||
      a.entryBytes - b.entryBytes ||
      compareOrdinal(a.entry.definition.key, b.entry.definition.key),
  );

  const selected: ReturnType<typeof projectEntry>[] = [];
  const descriptionHits = new Map<string, number>();
  let bytes = Buffer.byteLength('[]');
  for (const match of ranked) {
    const { entry, entryBytes, exact, identityMatches, inDraft } = match;
    const descriptionOnly =
      !exact && identityMatches === 0 && !inDraft && match.familyMatches === 0;
    const count = (term: string) => descriptionHits.get(term) ?? 0;
    if (
      descriptionOnly &&
      match.descriptionMatches.every(
        (term) => count(term) >= DESCRIPTION_MATCHES_PER_TERM,
      )
    )
      continue;
    const size = entryBytes + Number(selected.length > 0);
    const byteLimit =
      descriptionOnly && match.descriptionMatches.length === 1
        ? DESCRIPTION_CONTEXT_BYTES
        : CATALOG_CONTEXT_BYTES;
    if (bytes + size > byteLimit) continue;
    for (const term of match.descriptionMatches)
      descriptionHits.set(term, count(term) + 1);
    selected.push(entry);
    bytes += size;
    if (selected.length === CATALOG_CONTEXT_ENTRIES) break;
  }
  return selected;
}

type ProposalCatalog = ReturnType<typeof proposalCatalog>;

export function expandProposalCatalog(
  catalog: ListNodeDefinitionsService,
  draft: WorkflowGraph,
  previous: ProposalCatalog,
  query: string,
) {
  const seen = new Set(previous.map(({ definition }) => identity(definition)));
  const additional = proposalCatalog(catalog, query, draft, seen).slice(
    0,
    CATALOG_LOOKUP_ENTRIES,
  );
  if (additional.length === 0) return { entries: previous, found: false };
  const entries: ProposalCatalog = [];
  for (const entry of [...additional, ...previous]) {
    const expanded = [...entries, entry];
    if (Buffer.byteLength(JSON.stringify(expanded)) <= CATALOG_CONTEXT_BYTES)
      entries.push(entry);
    if (entries.length === CATALOG_CONTEXT_ENTRIES) break;
  }
  return { entries, found: true };
}

function projectEntry(item: CatalogEntry, existingOnly: boolean) {
  const { default: _editorPreset, ...configSchema } = item.configSchema;
  return {
    name: item.presentation?.name ?? item.display?.name ?? item.definition.key,
    description: item.display?.description,
    definition: item.definition,
    configVersion: item.configVersion,
    ports: item.ports,
    configSchema,
    inputSchema: item.inputSchema,
    ...(existingOnly ? { existingOnly } : {}),
  };
}

function identity({ key, version }: CatalogEntry['definition']) {
  return `${key}@${String(version)}`;
}

function words(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function overlap(query: ReadonlySet<string>, terms: readonly string[]) {
  return matchingTerms(query, terms).length;
}

function matchingTerms(query: ReadonlySet<string>, terms: readonly string[]) {
  return [...new Set(terms)].filter((term) => query.has(term));
}
