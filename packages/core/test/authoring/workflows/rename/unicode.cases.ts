import { it, expect } from 'vitest';
import type { WorkflowAuthoringStore } from '../../../../src/authoring/workflows/contract.js';

export function registerUnicodeRenameCase({
  createNamed,
  rename,
  nameFacts,
}: Readonly<{
  createNamed(name: string): Promise<string>;
  rename(
    workflowId: string,
    overrides?: Partial<
      Parameters<WorkflowAuthoringStore['renameWorkflow']>[0]
    >,
  ): ReturnType<WorkflowAuthoringStore['renameWorkflow']>;
  nameFacts(workflowId: string): Promise<
    Readonly<{
      name: string;
      nameRevision: number;
      receipts: number;
      audits: number;
    }>
  >;
}>) {
  it('preserves Unicode code points through no-op receipts and later renames', async () => {
    const decomposed = 'レポート e\u0301 🚀';
    const composed = 'レポート é 🚀';
    expect(decomposed.normalize('NFC')).toBe(composed);
    const workflowId = await createNamed(`  ${decomposed}  `);
    const accepted = await rename(workflowId, { name: `\t${decomposed}\n` });
    expect(accepted.workflow.name).toBe(decomposed);
    expect(Object.isFrozen(accepted.workflow)).toBe(true);
    expect(await nameFacts(workflowId)).toMatchObject({
      name: decomposed,
      nameRevision: 1,
      receipts: 1,
      audits: 0,
    });
    await rename(workflowId, {
      idempotencyKey: `rename-composed-${workflowId}`,
      name: composed,
    });
    expect(await nameFacts(workflowId)).toMatchObject({
      name: composed,
      nameRevision: 2,
      receipts: 2,
      audits: 1,
    });
    await expect(rename(workflowId, { name: decomposed })).resolves.toEqual({
      replayed: true,
      workflow: accepted.workflow,
    });
  });
}
