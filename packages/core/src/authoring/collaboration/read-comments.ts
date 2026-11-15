import type {
  WorkflowCommentDetail,
  WorkflowCommentList,
  WorkspacePeoplePage,
} from '@pertexo/contracts';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import { readWorkspacePeople } from '../../tenant-access/members/discovery.repository.js';
import { projectCommentThread } from './comment-threads.repository.js';
import type { EnterCollaboration } from './enter-collaboration.js';
import type {
  ListCommentsInput,
  ReadPeopleInput,
  ReadThreadInput,
} from './workflow-collaboration.types.js';
import { requireThread } from './workflow-collaboration.errors.js';
import {
  commentInThread,
  listThreadRows,
  projectComments,
  readThreadCommentRows,
  readThreadRow,
} from './comment-reads.repository.js';

export function collaborationReads(enter: EnterCollaboration) {
  return {
    list: (input: ListCommentsInput): Promise<WorkflowCommentList> =>
      enter(input, { browsing: true }, async (client) => {
        const found = await listThreadRows(client, input);
        const rows = found.slice(0, input.limit);
        return {
          items: rows.map(projectCommentThread),
          nextCursor:
            found.length > input.limit ? (rows.at(-1)?.id ?? null) : null,
        };
      }),
    read: (input: ReadThreadInput): Promise<WorkflowCommentDetail> =>
      enter(input, { browsing: true }, async (client) => {
        const thread = requireThread(await readThreadRow(client, input));
        if (
          input.anchor !== undefined &&
          !(await commentInThread(client, { ...input, anchor: input.anchor }))
        )
          throw new WorkflowNotFoundError('Comment is not visible');
        const found = await readThreadCommentRows(client, input);
        const rows = found.slice(0, input.limit);
        return {
          thread: projectCommentThread(thread),
          comments: await projectComments(client, input.workspaceId, rows),
          nextCursor:
            found.length > input.limit ? (rows.at(-1)?.id ?? null) : null,
        };
      }),
    people: (input: ReadPeopleInput): Promise<WorkspacePeoplePage> =>
      enter(input, { browsing: true }, async (client) => {
        return readWorkspacePeople(client, input);
      }),
  };
}
