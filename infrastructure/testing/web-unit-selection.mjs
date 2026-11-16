import { existsSync } from 'node:fs';
// Only source and ordinary test edits can use Vitest's related module graph.
export function relatedWebFiles(files, event = 'pull_request') {
  if (event !== 'pull_request' || files.length === 0) return undefined;
  if (
    files.some(
      (file) =>
        !existsSync(file) ||
        !/^apps\/web\/(src\/.+|test\/.+\.test\.tsx?)$/u.test(file) ||
        /^apps\/web\/test\/(setup\.ts|support\/)/u.test(file),
    )
  )
    return undefined;
  return files.map((file) => file.slice('apps/web/'.length));
}
