const SEQUENCE_WIDTH = 20;

export function recordKey(workspaceId: string, sequence: number): string {
  return `control-ledger/workspaces/${workspaceId}/records/${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.json`;
}
