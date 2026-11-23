import { expect, it } from 'vitest';
import {
  invocationReference,
  parseInvocationReference,
} from '../../../src/runs/mcp/invocation-reference.js';

it('reads both newly issued and retained invocation references', () => {
  const runId = 'bf522673-2dd9-48d9-ba8f-10578c708d23';
  const tokenId = '37b57c0a-07d8-4246-9833-39230ddaf40d';
  const retained =
    'YmY1MjI2NzMtMmRkOS00OGQ5LWJhOGYtMTA1NzhjNzA4ZDIzLjA2M2FjN2YzMDEwOGRmODU5ZTI4YzkxNDVhY2ZkNWQxMDViZDY3OGZjODcyNmE5NmIzNjYyZmQ4MjZjOTBjODQ';
  const issued = invocationReference(runId, tokenId);
  expect(issued).toBe(retained);
  expect(parseInvocationReference(issued)).toBe(runId);
  expect(parseInvocationReference(retained)).toBe(runId);
  expect(parseInvocationReference(retained.slice(1))).toBeUndefined();
});
