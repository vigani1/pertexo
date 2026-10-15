import {
  approvalAudiencePageSchema,
  pendingTaskResponseSchema,
  pendingTaskListResponseSchema,
  pendingTaskDecisionResponseSchema,
} from '@pertexo/contracts';
import type { PendingTaskStore } from '@pertexo/database/runs';
import { taskOperation } from './errors.js';

/** Transport contracts surround the same transaction-owned task rules. */
export class PendingTaskService {
  constructor(private readonly store: PendingTaskStore) {}
  list(input: Parameters<PendingTaskStore['list']>[0]) {
    return taskOperation(async () =>
      pendingTaskListResponseSchema.parse(await this.store.list(input)),
    );
  }
  read(input: Parameters<PendingTaskStore['read']>[0]) {
    return taskOperation(async () =>
      pendingTaskResponseSchema.parse({ task: await this.store.read(input) }),
    );
  }
  decide(input: Parameters<PendingTaskStore['decide']>[0]) {
    return taskOperation(async () =>
      pendingTaskDecisionResponseSchema.parse(await this.store.decide(input)),
    );
  }
  audience(input: Parameters<PendingTaskStore['audience']>[0]) {
    return taskOperation(async () =>
      approvalAudiencePageSchema.parse(await this.store.audience(input)),
    );
  }
}
