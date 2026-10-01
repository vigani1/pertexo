import type { NodeConnectionHealthObservation } from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';

import { createConnectionHealthCapture } from '../src/execution/connection-health-capture.js';

describe('capture-only run connection health', () => {
  it.each([false, true])(
    'captures nothing before a durable dispatch (enabled %s)',
    (enabled) => {
      const capture = createConnectionHealthCapture(enabled, () => false);
      capture.observe({ kind: 'healthy' });
      expect(capture.read()).toBeUndefined();
    },
  );

  it('mode off captures nothing even after dispatch', () => {
    const capture = createConnectionHealthCapture(false, () => true);
    capture.observe({
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_revoked',
    });
    expect(capture.read()).toBeUndefined();
  });

  it('clones one bounded observation and accepts identical capture only', () => {
    const capture = createConnectionHealthCapture(true, () => true);
    const value = {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_revoked',
    } as const;
    capture.observe(value);
    const stored = capture.read();
    expect(stored).toEqual(value);
    expect(stored).not.toBe(value);
    expect(Object.isFrozen(stored)).toBe(true);
    capture.observe({ ...value });
    expect(capture.read()).toEqual(value);
    capture.observe({ kind: 'healthy' });
    expect(capture.read()).toBeUndefined();
    capture.observe(value);
    expect(capture.read()).toBeUndefined();
  });

  it.each([
    null,
    {},
    { kind: 'healthy', token: 'secret' },
    { kind: 'reauthorization_required', reasonCode: 'invalid_auth' },
    {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_revoked',
      connectionId: 'unrelated',
    },
    new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('hostile caller');
        },
      },
    ),
  ])('malformed caller %# never throws or retains evidence', (value) => {
    const capture = createConnectionHealthCapture(true, () => true);
    expect(() => {
      capture.observe(value as NodeConnectionHealthObservation);
    }).not.toThrow();
    expect(capture.read()).toBeUndefined();
  });
});
