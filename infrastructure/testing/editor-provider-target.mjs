// Product specs own the server on the web preview's neighbouring port.
export function editorProviderTarget(input, port) {
  const url = new URL(input.url);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.provider.test') ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  )
    return undefined;
  const target = new URL(`http://127.0.0.1:${port}`);
  target.pathname = url.pathname;
  target.search = url.search;
  return { ...input, url: target.href, maxRedirects: 0 };
}
