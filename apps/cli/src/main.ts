import { fileURLToPath } from 'node:url';

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

if (isMainModule()) {
  if (process.argv[2] === 'automation') {
    void import('./run.js')
      .then(({ runAutomationCli }) => runAutomationCli(process.argv.slice(3)))
      .catch(() => {
        process.stderr.write(
          `${JSON.stringify({ code: 'cli.bootstrap_failed', detail: 'The automation CLI could not be started.' })}\n`,
        );
        process.exitCode = 1;
      });
  }
}
