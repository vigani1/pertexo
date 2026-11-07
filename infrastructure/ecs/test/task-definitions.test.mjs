import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('runner-free ECS API and worker tasks consistently disable Code', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-ecs-code-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync(
    process.execPath,
    ['infrastructure/ecs/render-task-definitions.mjs', directory],
    {
      env: {
        ...process.env,
        ECS_IMAGE_URI: 'fixture/pertexo@sha256:' + 'a'.repeat(64),
        ECS_EXECUTION_ROLE_ARN_PREFIX:
          'arn:aws:iam::123456789012:role/execution',
        ECS_TASK_ROLE_ARN_PREFIX: 'arn:aws:iam::123456789012:role/task',
        ECS_CONFIG_PREFIX_ARN:
          'arn:aws:ssm:eu-central-1:123456789012:parameter/pertexo',
        ECS_SECRET_PREFIX_ARN:
          'arn:aws:secretsmanager:eu-central-1:123456789012:secret:pertexo',
        ECS_LOG_GROUP: '/pertexo/qualification',
      },
      stdio: 'pipe',
    },
  );
  for (const name of ['api', 'worker']) {
    const task = JSON.parse(
      readFileSync(join(directory, `${name}.json`), 'utf8'),
    );
    const container = task.containerDefinitions.find(
      (item) => item.name === name,
    );
    assert.deepEqual(
      container.environment.find((item) => item.name === 'CODE_STEPS_ENABLED'),
      {
        name: 'CODE_STEPS_ENABLED',
        value: 'false',
      },
      `${name} must not advertise an unreachable runner`,
    );
    assert.equal(
      container.secrets.some((item) => item.name === 'CODE_STEPS_ENABLED'),
      false,
    );
  }
});
