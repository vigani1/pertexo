import { Client } from 'pg';
import { z } from 'zod';
import { scenario } from '../fixture/environment.js';
import { recheckOwnership } from '../fixture/lifecycle.js';
import type { EditorControlRequest } from './contract.js';

const pollScope = z.tuple([z.uuid(), z.uuid(), z.uuid()]);

/** Bring forward an owned poll's next check without changing its configured interval. */
export function handleEditorPollDue({
  context,
  request,
  response,
  url,
}: EditorControlRequest) {
  if (
    scenario !== 'http-polling' ||
    request.method !== 'POST' ||
    url.pathname !== '/polling-due'
  )
    return false;

  const values = pollScope.safeParse([
    url.searchParams.get('workspaceId'),
    url.searchParams.get('workflowId'),
    url.searchParams.get('workflowVersionId'),
  ]);
  if (!values.success) {
    response.writeHead(400).end();
    return true;
  }

  void (async () => {
    await recheckOwnership();
    const result = await context.api.database().query(
      `update app.trigger_polls poll set next_poll_at = statement_timestamp()
       from app.workflow_triggers trigger
       where poll.workspace_id=trigger.workspace_id and poll.trigger_id=trigger.id
         and trigger.workspace_id=$1 and trigger.workflow_id=$2 and trigger.workflow_version_id=$3
         and poll.seen_keys is not null and poll.retired_at is null and poll.lease_token is null`,
      values.data,
    );
    response.writeHead(result.rowCount === 1 ? 204 : 409).end();
  })().catch(() => {
    response.writeHead(500).end('Could not bring forward the owned poll');
  });
  return true;
}

/** Insert the next row on the disposable destination seeded for this journey. */
export function handleEditorPollInsert({
  context,
  request,
  response,
  url,
}: EditorControlRequest) {
  const credential = context.postgresDestination;
  if (
    scenario !== 'http-polling' ||
    request.method !== 'POST' ||
    url.pathname !== '/postgres-poll-row' ||
    credential === undefined
  )
    return false;
  void (async () => {
    await recheckOwnership();
    const client = new Client(credential);
    await client.connect();
    try {
      await client.query(
        "insert into public.poll_rows values ('new-item', 2, 'ready')",
      );
    } finally {
      await client.end();
    }
    response.writeHead(204).end();
  })().catch(() => {
    response.writeHead(500).end('Could not add a row to the owned destination');
  });
  return true;
}
