import type { OutgoingHttpHeaders } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createIngressFixture } from '../ingress/fixture.js';
import { currentSecret } from '../ingress/environment.js';
import { request } from '../ingress/requests.js';

const caseFixture = createIngressFixture();

const STORED_TYPES = [
  'application/xml',
  'text/plain',
  'text/csv',
  'application/json',
] as const;

const SCRIPT_RUN = `<html xmlns="http://www.w3.org/1999/xhtml"><script>document.title='ran'</script></html>`;

function reply(contentType: (typeof STORED_TYPES)[number]) {
  const f = caseFixture.setup({});
  f.database.acceptVerifiedDelivery.mockResolvedValue({
    runId: '99999999-9999-4999-8999-999999999999',
    replayed: false,
    responseWaitSeconds: 1,
  });
  f.database.readResponse.mockResolvedValue({
    state: 'responded',
    response: {
      statusCode: 200,
      contentType,
      headers: {},
      body: SCRIPT_RUN,
    },
  });
  return f.application.inject(request('{}', currentSecret));
}

/** A browser opening this can't run it: no scripts, and no page to attach to. */
function expectInert(headers: OutgoingHttpHeaders): void {
  const policy = headers['content-security-policy']?.toString() ?? '';
  expect(policy).toMatch(/default-src 'none'/u);
  expect(policy).toMatch(/\bsandbox\b/u);
  expect(headers['x-content-type-options']).toBe('nosniff');
}

describe('a workflow response opened in a browser', () => {
  it.each(STORED_TYPES)(
    'carries a policy that stops script for %s',
    async (contentType) => {
      expectInert((await reply(contentType)).headers);
    },
  );
});
