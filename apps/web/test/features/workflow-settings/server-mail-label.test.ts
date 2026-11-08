import { expect, it } from 'vitest';
import { describeDestination } from '@/features/workflow-settings/model/destination-label';

it('names a server-mail member in workflow destination choices', () => {
  const memberId = '11111111-1111-4111-8111-111111111111';
  expect(
    describeDestination(
      { config: { kind: 'system_mail', memberId } },
      new Map(),
      new Map(),
      new Map([[memberId, 'Ada · ada@example.test']]),
    ),
  ).toBe("Ada · ada@example.test via this server's mail");
});
