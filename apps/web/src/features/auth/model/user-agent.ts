// Turns a stored user-agent string into words people recognise, like
// "Chrome on macOS". Order matters: many browsers also claim to be Chrome or
// Safari, so the more specific names are checked first.

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//u, 'Edge'],
  [/\b(?:OPR|Opera)\//u, 'Opera'],
  [/\bSamsungBrowser\//u, 'Samsung Internet'],
  [/\bVivaldi\//u, 'Vivaldi'],
  [/\bBrave\//u, 'Brave'],
  [/\b(?:Firefox|FxiOS)\//u, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//u, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//u, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPad\b/u, 'iPadOS'],
  [/\b(?:iPhone|iPod)\b/u, 'iOS'],
  [/\bAndroid\b/u, 'Android'],
  [/\bCrOS\b/u, 'ChromeOS'],
  [/\bWindows\b/u, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/u, 'macOS'],
  [/\bLinux\b/u, 'Linux'],
];

function firstMatch(
  value: string,
  table: readonly (readonly [RegExp, string])[],
): string | undefined {
  return table.find(([pattern]) => pattern.test(value))?.[1];
}

/** "Chrome on macOS"; falls back to what is known, never the raw string. */
export function describeUserAgent(userAgent: string | null): string {
  if (userAgent === null || userAgent.trim().length === 0)
    return 'Unknown browser';
  const browser = firstMatch(userAgent, BROWSERS);
  const system = firstMatch(userAgent, SYSTEMS);
  if (browser !== undefined && system !== undefined)
    return `${browser} on ${system}`;
  if (browser !== undefined) return browser;
  if (system !== undefined) return `A browser on ${system}`;
  return 'Unknown browser';
}
