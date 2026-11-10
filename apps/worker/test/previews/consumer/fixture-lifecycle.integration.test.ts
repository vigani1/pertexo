import { describe, expect, it } from 'vitest';

import {
  workerTransportIntegrationEnabled,
  workspaceId,
} from '../../support/previews/consumer/environment.js';
import { withOwner } from '../../support/previews/consumer/lifecycle.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

describeIntegration('preview consumer fixture lifecycle', () => {
  it('creates an active workspace for the consumer', async () => {
    const result = await withOwner((client) =>
      client.query<{ status: string }>(
        'select status from app.workspaces where id=$1',
        [workspaceId],
      ),
    );
    expect(result.rows).toEqual([{ status: 'active' }]);
  });
});
