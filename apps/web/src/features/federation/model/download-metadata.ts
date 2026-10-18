/** Download only the bounded public metadata returned by the authenticated API. */
export function downloadSamlMetadata(xml: string) {
  const url = URL.createObjectURL(
    new Blob([xml], { type: 'application/samlmetadata+xml' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pertexo-saml.xml';
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
