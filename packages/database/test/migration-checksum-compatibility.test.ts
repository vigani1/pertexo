import { describe, expect, it } from 'vitest';

import { isCompatibleMigrationChecksum } from '../src/migrations.js';

describe('published migration checksum compatibility', () => {
  it('accepts exact checksums and only known published variants', () => {
    expect(
      isCompatibleMigrationChecksum('0001_example.sql', 'same', 'same'),
    ).toBe(true);
    expect(
      isCompatibleMigrationChecksum(
        '0037_failure_notification_destinations.sql',
        'current',
        '9f76e5fefc3914a808cb000f796760e17902876a4418d006bb82674d7778eede',
      ),
    ).toBe(true);
    expect(
      isCompatibleMigrationChecksum(
        '0038_execution_admission.sql',
        'current',
        '89117c0311337b655503557f7a66f63c04aa9eb6736be6ddfc4b02dea4eedf95',
      ),
    ).toBe(true);
    expect(
      isCompatibleMigrationChecksum(
        '0038_execution_admission.sql',
        'current',
        '0b7c70eee52daefeacbd092e1831852aa4260b60b899832b565ec524e47b2be2',
      ),
    ).toBe(true);
    expect(
      isCompatibleMigrationChecksum(
        '0038_execution_admission.sql',
        'current',
        '27ca68dc5e20560d80fbaab2524b3cd0c9fe0361b68792538a69aac30d4f9857',
      ),
    ).toBe(true);
    expect(
      isCompatibleMigrationChecksum(
        '0070_preview_execution_deadline.sql',
        'current',
        'beabac6354d519a98878e57645d74c8afa8c46454bf13fc3886835774da0c914',
      ),
    ).toBe(true);
    expect(
      isCompatibleMigrationChecksum(
        '0038_execution_admission.sql',
        'current',
        'unpublished',
      ),
    ).toBe(false);
    expect(
      isCompatibleMigrationChecksum(
        '0040_generic_webhook_triggers.sql',
        'current',
        '9f76e5fefc3914a808cb000f796760e17902876a4418d006bb82674d7778eede',
      ),
    ).toBe(false);
  });
});
