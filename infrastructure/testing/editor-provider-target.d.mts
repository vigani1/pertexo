export function editorProviderTarget<
  Request extends { readonly url: string; readonly maxRedirects: number },
>(input: Request, port: string | number): Request | undefined;
