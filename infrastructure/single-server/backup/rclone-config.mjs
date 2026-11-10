import { writeFile } from 'node:fs/promises';

export async function writeRcloneConfig(filename, remotes) {
  const lines = [];
  for (const [remote, settings] of Object.entries(remotes)) {
    lines.push(`[${remote.toLowerCase()}]`);
    for (const [field, value] of Object.entries(settings)) {
      if (/[\r\n]/u.test(value))
        throw new Error(`Backup ${field} must fit on one line`);
      // Rclone's INI quoting preserves whitespace, quotes and shell metacharacters.
      lines.push(`${field.toLowerCase()} = \`${value}\``);
    }
  }
  await writeFile(filename, lines.join('\n') + '\n', { mode: 0o600 });
}
