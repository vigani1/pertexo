/**
 * How long a download's object URL lives. Revoking it straight after the
 * click can cancel the download in some browsers, because the browser
 * reads the URL after the click returns. A minute is far longer than any
 * start takes, and the memory it holds is one small text file.
 */
export const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/** Saves text the page already holds as a file, with a fixed name. */
export function downloadTextFile(
  file: Readonly<{ name: string; type: string; text: string }>,
) {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  // Firefox starts a download only from a link in the document.
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, DOWNLOAD_URL_LIFETIME_MS);
}
