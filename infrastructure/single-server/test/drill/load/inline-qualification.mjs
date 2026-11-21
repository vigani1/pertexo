import assert from 'node:assert/strict';
import { INLINE_STEPS, sqlJson } from './stack.mjs';

export const QUALIFICATION_SET_NODE_ID = 'after';

export async function verifySetExecution(server, record) {
  // These fixtures name the versioned Set step "after". A successful attempt
  // has a nonzero fence token only when it was claimed by an attempt worker.
  const attempts = await sqlJson(
    server,
    `select json_build_object(
      'inline', count(*) filter (where a.fence_token = 0),
      'leased', count(*) filter (where a.fence_token > 0)
    )
    from app.node_attempts a
    join app.node_runs n on n.id = a.node_run_id
    where n.node_id = '${QUALIFICATION_SET_NODE_ID}' and a.status = 'succeeded'`,
  );
  const enabled = INLINE_STEPS === 'true';
  record('Set execution', { enabled, ...attempts });
  if (enabled) assert.ok(attempts.inline > 0, 'at least one Set ran inline');
  else {
    assert.equal(attempts.inline, 0);
    assert.ok(
      attempts.leased > 0,
      'at least one Set ran via an attempt delivery',
    );
  }
}
