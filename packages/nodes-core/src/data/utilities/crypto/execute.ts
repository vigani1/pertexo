import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CryptoConfig } from './validation.js';
import { refuseUtility } from '../result.js';
export function transformCrypto(
  config: CryptoConfig,
  value: string | undefined,
) {
  switch (config.operation) {
    case 'uuid':
      return { value: randomUUID() };
    case 'random_id':
      return {
        value: randomBytes(config.length)
          .toString('base64url')
          .slice(0, config.length),
      };
    case 'hash':
      if (value === undefined)
        return refuseUtility('crypto_input', 'Hash needs a text value.');
      return {
        value: createHash(config.algorithm)
          .update(value, 'utf8')
          .digest(config.encoding),
      };
  }
}
