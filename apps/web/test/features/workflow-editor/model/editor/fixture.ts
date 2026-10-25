import type { WorkflowGraphContract } from '@pertexo/contracts';
export function emptyGraph(): WorkflowGraphContract {
  return { nodes: [], edges: [], settings: {} };
}

export const loopRow = (port: string) =>
  ({
    id: 'loop',
    destinationKey: 'order',
    kind: 'structured_input',
    port,
    path: '$.id',
  }) as const;
