import { describe, expect, it } from 'vitest';
import {
  cancellationFailure,
  scannerCloseFailure,
} from '../../../src/triggers/schedules/scanning/scan-failures.js';

describe('schedule scan failures', () => {
  it('reports nothing until the scan is aborted, then the abort reason', () => {
    const controller = new AbortController();
    expect(cancellationFailure(undefined)).toBeUndefined();
    expect(cancellationFailure(controller.signal)).toBeUndefined();
    const reason = new Error('stopping');
    controller.abort(reason);
    expect(cancellationFailure(controller.signal)).toBe(reason);
  });

  it('wraps an abort reason that is not an Error', () => {
    const controller = new AbortController();
    controller.abort('stop');
    const failure = cancellationFailure(controller.signal);
    expect(failure?.message).toBe('Schedule scan aborted');
    expect(failure?.cause).toBe('stop');
  });

  it('reports one close failure as itself and several together', () => {
    const first = new Error('claim pool');
    expect(scannerCloseFailure([])).toBeUndefined();
    expect(scannerCloseFailure([first])).toBe(first);
    const both = scannerCloseFailure([first, new Error('acceptance pool')]);
    expect(both).toBeInstanceOf(AggregateError);
    expect((both as AggregateError).errors).toHaveLength(2);
  });
});
