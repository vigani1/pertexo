import {
  workspaceInboxListResponseSchema,
  workspaceInboxReadAllResponseSchema,
  workspaceInboxReadResponseSchema,
  workspaceInboxSummaryResponseSchema,
  type WorkspaceInboxFilter,
  type WorkspaceInboxListResponse,
  type WorkspaceInboxReadAllResponse,
  type WorkspaceInboxReadResponse,
  type WorkspaceInboxSummaryResponse,
} from '@pertexo/contracts/workspace-inbox';
import type { WorkspaceInboxDatabase } from '@pertexo/database/api';

import {
  decodeWorkspaceInboxCursor,
  encodeWorkspaceInboxCursor,
} from './cursor.js';

export class WorkspaceInboxThreadNotFoundError extends Error {
  public override readonly name = 'WorkspaceInboxThreadNotFoundError';
}

type Reader = Readonly<{ workspaceId: string; actorId: string }>;

const DEFAULT_PAGE_SIZE = 25;

/**
 * ADR 055: the reader's view of their workspace's failure threads. Guards
 * check `notification:read`; row-level security applies the same eligibility
 * to every statement, so an ineligible reader sees nothing.
 */
export class WorkspaceInboxService {
  public constructor(private readonly database: WorkspaceInboxDatabase) {}

  public async list(
    input: Reader &
      Readonly<{
        filter?: WorkspaceInboxFilter;
        limit?: number;
        after?: string;
        signal?: AbortSignal;
      }>,
  ): Promise<WorkspaceInboxListResponse> {
    const filter = input.filter ?? 'all';
    const context = { workspaceId: input.workspaceId, filter };
    const page = await this.database.listThreads({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      filter,
      limit: input.limit ?? DEFAULT_PAGE_SIZE,
      ...(input.after === undefined
        ? {}
        : { after: decodeWorkspaceInboxCursor(input.after, context) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return workspaceInboxListResponseSchema.parse({
      items: page.items,
      nextCursor:
        page.next === null
          ? null
          : encodeWorkspaceInboxCursor(context, page.next),
      revision: page.revision,
    });
  }

  public async summary(
    input: Reader & Readonly<{ signal?: AbortSignal }>,
  ): Promise<WorkspaceInboxSummaryResponse> {
    return workspaceInboxSummaryResponseSchema.parse(
      await this.database.readSummary(input),
    );
  }

  public async markRead(
    input: Reader & Readonly<{ workflowId: string; revision: string }>,
  ): Promise<WorkspaceInboxReadResponse> {
    const read = await this.database.markThreadRead(input);
    if (read === undefined) throw new WorkspaceInboxThreadNotFoundError();
    return workspaceInboxReadResponseSchema.parse({
      workflowId: input.workflowId,
      ...read,
    });
  }

  public async markAllRead(
    input: Reader & Readonly<{ revision: string }>,
  ): Promise<WorkspaceInboxReadAllResponse> {
    return workspaceInboxReadAllResponseSchema.parse(
      await this.database.markAllRead(input),
    );
  }
}
