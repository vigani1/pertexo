import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  failureArtifactJourney,
  liveJourneyEnvironment,
} from './live-failure-artifacts.mjs';

// Review of batch K, P3-1: the editor journeys spread the parent's
// environment, so an exported variable turned traces on for all of them.
test('an exported request never turns traces on for another journey', () => {
  const parent = {
    PATH: '/bin',
    PERTEXO_LIVE_FAILURE_ARTIFACTS: 'callable',
  };
  const child = liveJourneyEnvironment(parent, 'http-secret-actions');
  assert.equal(child.PATH, '/bin');
  assert.equal('PERTEXO_LIVE_FAILURE_ARTIFACTS' in child, false);
  assert.equal(failureArtifactJourney(child), undefined);
});

test('a listed journey asks for its own artifacts, whatever was inherited', () => {
  const child = liveJourneyEnvironment(
    { PERTEXO_LIVE_FAILURE_ARTIFACTS: 'workflow-organization-admin' },
    'callable',
  );
  assert.equal(failureArtifactJourney(child), 'callable');
});

test('the live config refuses a journey that is not listed', () => {
  assert.throws(
    () =>
      failureArtifactJourney({
        PERTEXO_LIVE_FAILURE_ARTIFACTS: 'http-secret-actions',
      }),
    /must name a journey listed/u,
  );
});
