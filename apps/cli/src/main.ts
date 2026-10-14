#!/usr/bin/env node

void import('./run.js')
  .then(({ runAutomationCli }) => runAutomationCli(process.argv.slice(2)))
  .catch(() => {
    process.stderr.write(
      `${JSON.stringify({ code: 'cli.bootstrap_failed', detail: 'The automation CLI could not be started.' })}\n`,
    );
    process.exitCode = 1;
  });
