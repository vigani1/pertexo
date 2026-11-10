import { posix } from 'node:path';

export function uncoveredComposeFiles(files, updates) {
  const directories = updates
    .filter((update) => update['package-ecosystem'] === 'docker-compose')
    .flatMap((update) => update.directories ?? [update.directory]);
  return files.filter(
    (file) =>
      /(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/u.test(file) &&
      !directories.some((directory) =>
        posix.matchesGlob(
          `/${posix.dirname(file) === '.' ? '' : posix.dirname(file)}`,
          directory,
        ),
      ),
  );
}
