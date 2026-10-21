import { appendFile } from 'node:fs/promises';

export async function reportFileQualification(
  label: string,
  evidence: unknown,
) {
  const line = JSON.stringify({ label, evidence }) + '\n';
  process.stdout.write(line);
  const destination = process.env.F45_QUALIFICATION_REPORT;
  if (destination !== undefined) await appendFile(destination, line);
}
