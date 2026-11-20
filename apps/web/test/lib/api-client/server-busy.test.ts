import { describe, expect, it } from 'vitest';

import { createApiClient } from '../../../src/lib/api/client';
import {
  describeCommandError,
  describeReadError,
  readFailureReason,
} from '../../../src/lib/api/error-copy';

import {
  commonProblem,
  csrfToken,
  expectApiError,
  fetchMock,
  problemResponse,
  requestId,
} from './fixture';

describe('a request the API turned away as busy', () => {
  function busyClient() {
    return createApiClient({
      fetch: fetchMock(
        problemResponse(
          commonProblem({
            type: 'urn:pertexo:problem:server.busy',
            title: 'Server busy',
            status: 503,
            code: 'server.busy',
          }),
          {
            status: 503,
            headers: { 'retry-after': '1', 'x-request-id': requestId },
          },
        ),
      ),
      readCsrfToken: () => csrfToken,
    });
  }

  it('says the server is busy for a read', async () => {
    const read = await expectApiError(
      busyClient().request({
        path: '/v1/examples',
        response: { kind: 'json', decode: (value) => value },
      }),
      'problem',
    );

    expect(describeReadError(read, 'Runs')).toBe(
      'The server is busy. Try again in a moment.',
    );
    expect(readFailureReason(read)).toBe(
      'The server is busy. Try again in a moment.',
    );
  });

  it('says a command did not happen, since none of it ran', async () => {
    const command = await expectApiError(
      busyClient().request({
        path: '/v1/examples',
        method: 'POST',
        body: {},
        response: { kind: 'json', decode: (value) => value },
      }),
      'problem',
    );

    expect(describeCommandError(command, 'saving the draft')).toBe(
      'The server is busy, so saving the draft didn’t happen. Try again in a moment.',
    );
  });
});
