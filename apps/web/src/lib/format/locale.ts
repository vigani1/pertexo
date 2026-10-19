/**
 * The interface is written in English, so its dates and relative times are
 * too, kept to the person's regional conventions: a German browser gets
 * "Tue, 20 Oct, 07:09" and "5 min ago" rather than "Di., 20. Okt." and
 * "vor 5 Min." beside English words. Regions Intl has no English for fall
 * back to plain English.
 */
export const FORMAT_LOCALE = englishIn(navigator.language);

function englishIn(language: string): string {
  try {
    const region = new Intl.Locale(language).maximize().region;
    return region === undefined ? 'en' : `en-${region}`;
  } catch {
    return 'en';
  }
}
