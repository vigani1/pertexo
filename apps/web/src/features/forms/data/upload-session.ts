// A response session ties one form or task response to the files uploaded
// for it; the server reads it from this header. Making one calls no server.
export const UPLOAD_SESSION_HEADER = 'x-pertexo-form-session';

export function newUploadSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
