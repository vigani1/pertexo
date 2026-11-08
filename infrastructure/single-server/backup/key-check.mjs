import { pathToFileURL } from 'node:url';
import { rclone } from './transport.mjs';

export async function verifyBackupKey(transport = rclone) {
  let marker;
  try {
    marker = await transport(['cat', 'crypt:KEYCHECK']);
  } catch {
    throw new Error(
      'Cannot read or decrypt backup store: check BACKUP_STORE settings and provide the original BACKUP_CRYPT_PASSWORD and BACKUP_CRYPT_SALT',
    );
  }
  if (marker.trim() !== 'Pertexo encrypted backups')
    throw new Error(
      'Backup key check failed: provide the original BACKUP_CRYPT_PASSWORD and BACKUP_CRYPT_SALT',
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await verifyBackupKey();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
