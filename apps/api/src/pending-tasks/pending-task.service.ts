import type { PendingTaskStore } from '@pertexo/core/runs';
import type { IdentityWorkspaceStore } from '@pertexo/core/tenant-access';
import {
  approvalAudiencePageSchema,
  approvalAudienceInspectionResponseSchema,
  pendingTaskResponseSchema,
  pendingTaskListResponseSchema,
  pendingTaskDecisionResponseSchema,
} from '@pertexo/contracts';
export type PendingTaskOperations = PendingTaskStore &
  Readonly<{ audience: IdentityWorkspaceStore['listWorkspacePeople'] }>;

/** Transport contracts surround the same transaction-owned task rules. */
export class PendingTaskService {
  constructor(private readonly store: PendingTaskOperations) {}
  async list(input: Parameters<PendingTaskOperations['list']>[0]) {
    return pendingTaskListResponseSchema.parse(await this.store.list(input));
  }
  async read(input: Parameters<PendingTaskOperations['read']>[0]) {
    return pendingTaskResponseSchema.parse({
      task: await this.store.read(input),
    });
  }
  async decide(input: Parameters<PendingTaskOperations['decide']>[0]) {
    return pendingTaskDecisionResponseSchema.parse(
      await this.store.decide(input),
    );
  }
  async submit(input: Parameters<PendingTaskOperations['submit']>[0]) {
    return pendingTaskDecisionResponseSchema.parse(
      await this.store.submit(input),
    );
  }
  async inspectAudience(
    input: Parameters<PendingTaskOperations['inspectAudience']>[0],
  ) {
    return approvalAudienceInspectionResponseSchema.parse(
      await this.store.inspectAudience(input),
    );
  }
  async audience(input: Parameters<PendingTaskOperations['audience']>[0]) {
    return approvalAudiencePageSchema.parse(await this.store.audience(input));
  }
}
