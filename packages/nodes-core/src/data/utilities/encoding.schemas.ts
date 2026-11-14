import { labelledChoice } from '@pertexo/node-sdk';

/** How a hash or signature is written out: the same two ways for both. */
export const outputEncodingSchema = labelledChoice({
  hex: 'Hexadecimal (hex)',
  base64: 'Base64',
}).meta({ title: 'Encoding', default: 'hex' });
