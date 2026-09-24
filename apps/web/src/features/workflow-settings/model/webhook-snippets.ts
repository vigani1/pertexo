// How a sender signs a delivery: HMAC-SHA256 over "<timestamp>.<raw body>",
// keyed with the base64url-decoded signing secret, sent as "v1=<hex>".
// These are documentation strings shown to people, not code this app runs.

export const WEBHOOK_MAX_BODY = '256 KiB';
export const WEBHOOK_FRESHNESS = '5 minutes';

export const CURL_SNIPPET = [
  "SECRET='<signing secret>'",
  "URL='<your Pertexo API address>/hooks/<endpoint key>'",
  'BODY=\'{"event":"order.created","id":"ord_123"}\'',
  'TS=$(date +%s)',
  "KEY_HEX=$(printf '%s=' \"$SECRET\" | tr '_-' '/+' | base64 -d | xxd -p -c 256)",
  'SIG=$(printf \'%s.%s\' "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$KEY_HEX" | awk \'{print $NF}\')',
  '',
  'curl -X POST "$URL" \\',
  "  -H 'Content-Type: application/json' \\",
  '  -H "X-Pertexo-Timestamp: $TS" \\',
  '  -H "X-Pertexo-Signature: v1=$SIG" \\',
  '  --data "$BODY"',
].join('\n');

export const NODE_SNIPPET = [
  "import { createHmac } from 'node:crypto';",
  '',
  "const secret = Buffer.from(process.env.PERTEXO_SIGNING_SECRET, 'base64url');",
  "const body = JSON.stringify({ event: 'order.created', id: 'ord_123' });",
  'const timestamp = String(Math.floor(Date.now() / 1000));',
  "const signature = createHmac('sha256', secret)",
  '  .update(`${timestamp}.`)',
  '  .update(body)',
  "  .digest('hex');",
  '',
  'await fetch(process.env.PERTEXO_WEBHOOK_URL, {',
  "  method: 'POST',",
  '  headers: {',
  "    'Content-Type': 'application/json',",
  "    'X-Pertexo-Timestamp': timestamp,",
  "    'X-Pertexo-Signature': `v1=${signature}`,",
  '  },',
  '  body,',
  '});',
].join('\n');
