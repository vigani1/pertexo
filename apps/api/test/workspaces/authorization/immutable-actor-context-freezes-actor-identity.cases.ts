import { expect, it } from 'vitest';

import { actor } from './fixture.js';

export function registerImmutableActorContextFreezesActorIdentity(): void {
  it('freezes actor identity', () => {
    const context = actor();
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as { workspaceId: string }).workspaceId = 'other';
    }).toThrow();
  });
}
