// Shortcut hints in the keys people actually press: ⌘ and ⇧ on Apple
// devices, Ctrl and Shift everywhere else. The shortcuts themselves already
// accept either modifier.

function applePlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/iu.test(platform || navigator.userAgent);
}

const APPLE = applePlatform();

/** A shortcut as one hint, e.g. `shortcut('K')` → "⌘K" or "Ctrl K". */
export function shortcut(key: string, options: { shift?: boolean } = {}) {
  if (APPLE) return `${options.shift === true ? '⇧' : ''}⌘${key}`;
  return ['Ctrl', ...(options.shift === true ? ['Shift'] : []), key].join(' ');
}

/** A shortcut as separate keycaps, e.g. ["⇧", "⌘", "Z"] or ["Ctrl", "Shift", "Z"]. */
export function shortcutKeys(
  key: string,
  options: { shift?: boolean } = {},
): readonly string[] {
  return APPLE
    ? [...(options.shift === true ? ['⇧'] : []), '⌘', key]
    : ['Ctrl', ...(options.shift === true ? ['Shift'] : []), key];
}
