import { expect, it } from 'vitest';
import { lossOf } from '@/features/workspaces/model/member-access';
import { ApiError } from '@/lib/api/error';

const failed = (error: unknown) => ({ isError: true, error });

it('treats a refused team read as lost access, and a missing one only where the role hides it', () => {
  const refused = failed(
    new ApiError({ kind: 'problem', status: 403, message: 'No' }),
  );
  const missing = failed(
    new ApiError({ kind: 'problem', status: 404, message: 'No' }),
  );
  expect(lossOf({ query: refused, notFoundIsLoss: false })).toBe('permission');
  expect(lossOf({ query: missing, notFoundIsLoss: true })).toBe('permission');
  expect(lossOf({ query: missing, notFoundIsLoss: false })).toBeUndefined();
});

it('does not call a server or network failure, or a healthy read, a loss', () => {
  const broken = failed(
    new ApiError({ kind: 'problem', status: 500, message: 'No' }),
  );
  const offline = failed(new ApiError({ kind: 'network', message: 'offline' }));
  expect(lossOf({ query: broken, notFoundIsLoss: true })).toBeUndefined();
  expect(lossOf({ query: offline, notFoundIsLoss: true })).toBeUndefined();
  expect(
    lossOf({ query: { isError: false, error: null }, notFoundIsLoss: true }),
  ).toBeUndefined();
});
