import { expect, it } from 'vitest';

import { createStructuredLogger, redactLogText } from '../../src/logger.js';
import { captureDestination, testConfig } from './fixture.js';

const failedQuery = (params: string) =>
  `Failed query: insert into "app"."workflow_runs" ("id") values ($1)\nparams: ${params}`;

it('keeps the query and drops its parameters, however they are laid out', () => {
  const safe = redactLogText(
    `Error: ${failedQuery('one,{"body":"private\nsecond line"}')}\n    at insert (file.js:1:1)`,
  );
  expect(safe).toContain('insert into "app"."workflow_runs"');
  expect(safe).toContain('at insert (file.js:1:1)');
  expect(safe).not.toContain('private');
  expect(safe).not.toContain('second line');
});

it('keeps a failed query’s parameters out of a logged error and its cause', () => {
  const capture = captureDestination();
  const logger = createStructuredLogger(testConfig(), capture.destination);
  logger.error(
    'webhook.ingress_failed',
    {},
    new Error('Acceptance failed', {
      cause: new Error(failedQuery('{"body":"private"}')),
    }),
  );
  logger.error(
    'webhook.ingress_failed',
    {},
    new Error(failedQuery('{"body":"private"}')),
  );
  expect(JSON.stringify(capture.records)).toContain('Failed query');
  expect(JSON.stringify(capture.records)).not.toContain('private');
});

it('leaves a line that only mentions params alone', () => {
  expect(redactLogText('invalid params: expected a list')).toBe(
    'invalid params: expected a list',
  );
});
