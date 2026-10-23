import { expect, it, vi } from 'vitest';

import {
  ProblemDetailsFilter,
  RequestContextStore,
} from '../../../../src/platform/http/index.js';

import { responseMock, hostFor } from './fixture.js';

export function registerStillSendsSafeProblemExactlyOnce(): void {
  it('still sends the safe problem exactly once when logging throws synchronously', () => {
    const response = responseMock();
    const logger = {
      log: vi.fn(() => {
        throw new Error('sink failed');
      }),
    };

    expect(() => {
      new ProblemDetailsFilter(new RequestContextStore(), logger).catch(
        new Error('private failure'),
        hostFor({ url: '/v1/resource' }, response),
      );
    }).not.toThrow();
    expect(response.send).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({
      status: 500,
      code: 'internal.unexpected',
    });
  });
}
