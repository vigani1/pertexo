import type { QueryResult } from 'pg';

// Measures PostgreSQL JSON plans for the query-plan budget tests: which node
// types ran and how many rows each touched, including rows a filter rejected.

export type ExplainNode = Readonly<{
  'Node Type': string;
  'Index Name'?: string;
  'Heap Fetches'?: number;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Join Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: readonly ExplainNode[];
}>;

export type ExplainDocument = Readonly<{
  Plan: ExplainNode;
  'Execution Time'?: number;
  Settings?: Readonly<Record<string, string>>;
}>;

export function explainDocument(result: QueryResult): ExplainDocument {
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const documents = row?.['QUERY PLAN'];
  if (!Array.isArray(documents) || documents.length !== 1)
    throw new Error('expected one PostgreSQL JSON plan');
  return documents[0] as ExplainDocument;
}

export type ExplainWork = Readonly<{
  outputRowInstances: number;
  rejectedRowInstances: number;
  summedNodeRowWork: number;
  rootSharedBufferTouches: number;
  nodeTypes: readonly string[];
}>;

export function explainWork(node: ExplainNode): ExplainWork {
  const childWork = (node.Plans ?? []).map(explainWork);
  const loops = node['Actual Loops'];
  const outputRowInstances = node['Actual Rows'] * loops;
  const rejectedRowInstances =
    ((node['Rows Removed by Filter'] ?? 0) +
      (node['Rows Removed by Join Filter'] ?? 0) +
      (node['Rows Removed by Index Recheck'] ?? 0)) *
    loops;
  return {
    outputRowInstances:
      outputRowInstances +
      childWork.reduce((total, child) => total + child.outputRowInstances, 0),
    rejectedRowInstances:
      rejectedRowInstances +
      childWork.reduce((total, child) => total + child.rejectedRowInstances, 0),
    summedNodeRowWork:
      outputRowInstances +
      rejectedRowInstances +
      childWork.reduce((total, child) => total + child.summedNodeRowWork, 0),
    // PostgreSQL reports aggregate buffer use at the plan root. Do not add the
    // child counters again because that would double-count the same blocks.
    rootSharedBufferTouches:
      (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
    nodeTypes: [
      node['Node Type'],
      ...childWork.flatMap((child) => child.nodeTypes),
    ],
  };
}

export type IndexScan = Readonly<{
  nodeType: string;
  index: string;
  rows: number;
  heapFetches: number;
}>;

/** Every index scan in a plan, with the rows it emitted across its loops. */
export function indexScans(node: ExplainNode): readonly IndexScan[] {
  const own =
    node['Index Name'] === undefined
      ? []
      : [
          {
            nodeType: node['Node Type'],
            index: node['Index Name'],
            rows: node['Actual Rows'] * node['Actual Loops'],
            heapFetches: node['Heap Fetches'] ?? 0,
          },
        ];
  return [...own, ...(node.Plans ?? []).flatMap(indexScans)];
}
