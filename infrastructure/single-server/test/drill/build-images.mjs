import { RUNTIME_IMAGE, WEB_IMAGE } from './support/images.mjs';
import { must } from './support/process.mjs';

// One build per run: every drill file reuses these two tags.
const root = new URL('../../../../', import.meta.url).pathname;
const revision = await must('git', ['rev-parse', 'HEAD'], { cwd: root });
for (const [target, tag] of [
  ['runtime', RUNTIME_IMAGE],
  ['web', WEB_IMAGE],
])
  await must(
    'docker',
    [
      'buildx',
      'build',
      '--load',
      '--target',
      target,
      '--build-arg',
      `SOURCE_COMMIT=${revision}`,
      '--tag',
      tag,
      '.',
    ],
    { cwd: root, timeout: 1_500_000 },
  );
