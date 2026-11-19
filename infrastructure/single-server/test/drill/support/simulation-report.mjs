import { writeFileSync } from 'node:fs';
import { after } from 'node:test';

/**
 * What each scenario showed, kept whether it passed or not: the numbers and
 * messages a reader needs to judge the outcome. SIMULATION_REPORT names the file.
 */
export function createReport() {
  const report = {};
  after(() => {
    if (process.env.SIMULATION_REPORT)
      writeFileSync(
        process.env.SIMULATION_REPORT,
        `${JSON.stringify(report, null, 2)}\n`,
      );
  });
  return (scenario, facts) => {
    report[scenario] = { ...report[scenario], ...facts };
  };
}

/** The last lines of a long output, enough to show what someone read. */
export const tail = (text, lines = 12) =>
  text.trim().split('\n').slice(-lines).join('\n');
