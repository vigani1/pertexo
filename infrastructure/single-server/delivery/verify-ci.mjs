import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifyReleaseEvidence(commit, run, jobs) {
  if (!/^[0-9a-f]{40}$/u.test(commit))
    throw new Error('A full lowercase commit SHA is required');
  if (
    !run ||
    run.head_sha !== commit ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('The latest push CI run for this main commit must succeed');
  const publisher = jobs.find((job) => job.name === 'publish-images');
  if (
    !publisher ||
    publisher.head_sha !== commit ||
    publisher.status !== 'completed' ||
    publisher.conclusion !== 'success'
  )
    throw new Error('Image publication must succeed for this commit');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [commit, ...extra] = process.argv.slice(2);
  if (extra.length || !/^[0-9a-f]{40}$/u.test(commit))
    throw new Error('usage: verify-ci.mjs <full-40-character-commit>');
  const reference = process.env.GITHUB_REF ?? '';
  if (reference !== 'refs/heads/main' && !reference.startsWith('refs/tags/v'))
    throw new Error('Run this from main or a version tag');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('A GitHub repository is required');
  execFileSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], {
    stdio: 'pipe',
  });
  const api = (path) =>
    JSON.parse(
      execFileSync('gh', ['api', path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    );
  const runs = api(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&branch=main&event=push&per_page=1`,
  );
  const run = runs.workflow_runs?.[0];
  if (!run || !Number.isSafeInteger(run.id))
    throw new Error('No push CI run exists for this main commit');
  const result = api(
    `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
  );
  verifyReleaseEvidence(commit, run, result.jobs);
  console.log(`Verified main CI and image publication: ${commit}`);
}
