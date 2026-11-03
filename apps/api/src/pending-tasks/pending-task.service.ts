import {
  approvalAudiencePageSchema,
  approvalAudienceInspectionResponseSchema,
  pendingTaskResponseSchema,
  pendingTaskListResponseSchema,
  pendingTaskDecisionResponseSchema,
} from '@pertexo/contracts';
import type { PendingTaskStore } from '@pertexo/core/runs';

/** Transport contracts surround the same transaction-owned task rules. */
export class PendingTaskService {
  constructor(private readonly store: PendingTaskStore) {}
  async list(input: Parameters<PendingTaskStore['list']>[0]) {
    return pendingTaskListResponseSchema.parse(await this.store.list(input));
  }
  async read(input: Parameters<PendingTaskStore['read']>[0]) {
    return pendingTaskResponseSchema.parse({
      task: await this.store.read(input),
    });
  }
  async decide(input: Parameters<PendingTaskStore['decide']>[0]) {
    return pendingTaskDecisionResponseSchema.parse(
      await this.store.decide(input),
    );
  }
  async submit(input: Parameters<PendingTaskStore['submit']>[0]) {
    return pendingTaskDecisionResponseSchema.parse(
      await this.store.submit(input),
    );
  }
  async inspectAudience(
    input: Parameters<PendingTaskStore['inspectAudience']>[0],
  ) {
    return approvalAudienceInspectionResponseSchema.parse(
      await this.store.inspectAudience(input),
    );
  }
  async audience(input: Parameters<PendingTaskStore['audience']>[0]) {
    return approvalAudiencePageSchema.parse(await this.store.audience(input));
  }
}
