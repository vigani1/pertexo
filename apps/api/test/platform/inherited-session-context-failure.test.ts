import {
  APP_SETTING_NAMES,
  DATABASE_POOL_ROLES,
  InheritedSessionContextError,
} from '@pertexo/database/platform';
import {
  DESCRIBED_POOL_ROLES,
  describeProcessFailure,
} from '@pertexo/observability/server';
import { describe, expect, it } from 'vitest';

// The refusal comes from @pertexo/database and is described by
// @pertexo/observability, which can't depend on each other; this app sees
// both, so it holds their two definitions together.
describe("a pool's refusal of inherited app settings, as a process failure", () => {
  it('describes exactly the pool roles the database has, in both directions', () => {
    expect([...DESCRIBED_POOL_ROLES].sort()).toEqual(
      [...DATABASE_POOL_ROLES].sort(),
    );
  });

  it.each(DATABASE_POOL_ROLES)('names the %s pool and the setting', (role) => {
    const described = describeProcessFailure(
      new InheritedSessionContextError(role, ['app.workspace_id']),
    );

    expect(described).toContain(`the ${role} database pool`);
    expect(described).toContain('app.workspace_id');
    expect(described).not.toContain('[Redacted]');
  });

  it('names every app setting a pool checks', () => {
    const described = describeProcessFailure(
      new InheritedSessionContextError('api', [...APP_SETTING_NAMES]),
    );

    for (const name of APP_SETTING_NAMES) expect(described).toContain(name);
    expect(described).not.toContain('[Redacted]');
  });
});
