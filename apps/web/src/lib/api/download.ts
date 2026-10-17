/** Hand the transfer to the browser's download manager, without a Fetch/Blob buffer. */
export function submitNativeDownload(
  path: string,
  payload: string,
  csrfToken: string,
): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = path;
  form.target = '_blank';
  form.rel = 'noopener';
  form.acceptCharset = 'UTF-8';
  form.hidden = true;
  for (const [name, value] of Object.entries({ payload, csrfToken })) {
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = name;
    field.value = value;
    form.append(field);
  }
  document.body.append(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}
