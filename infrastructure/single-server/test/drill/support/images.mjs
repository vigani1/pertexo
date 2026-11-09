import { docker, mustDocker } from './process.mjs';

export const DRILL_PROJECT =
  process.env.DRILL_PROJECT ?? 'pertexo-b1-singleserver';

// The two product images are built once, by build-images.mjs, and every drill
// reuses them: the machine that runs this may be shared.
export const RUNTIME_IMAGE =
  process.env.DRILL_RUNTIME_IMAGE ?? 'pertexo-drill-runtime:local';
export const WEB_IMAGE =
  process.env.DRILL_WEB_IMAGE ?? 'pertexo-drill-web:local';

export async function requireImages() {
  for (const image of [RUNTIME_IMAGE, WEB_IMAGE]) {
    const found = await docker(['image', 'inspect', image]);
    if (found.status !== 0)
      throw new Error(
        `${image} is missing. Run: node infrastructure/single-server/test/drill/build-images.mjs`,
      );
  }
}

/** Publishes the built images under the names and revision deploy.sh verifies. */
export async function tagRelease(
  tag,
  revision = tag,
  runtimeImage = RUNTIME_IMAGE,
) {
  for (const [base, name] of [
    [runtimeImage, 'pertexo'],
    [WEB_IMAGE, 'pertexo-web'],
  ])
    await mustDocker(
      [
        'build',
        '--quiet',
        '--tag',
        `ghcr.io/vigani1/${name}:${tag}`,
        '--label',
        `org.opencontainers.image.revision=${revision}`,
        '--label',
        'pertexo.drill=true',
        '--label',
        `pertexo.drill.project=${DRILL_PROJECT}`,
        '-',
      ],
      { input: `FROM ${base}\n` },
    );
}

export async function removeReleaseTags(tags) {
  for (const tag of tags)
    for (const name of ['pertexo', 'pertexo-web'])
      await docker(['image', 'rm', `ghcr.io/vigani1/${name}:${tag}`]);
}
