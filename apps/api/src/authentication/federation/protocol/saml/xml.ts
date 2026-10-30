import { isUtf8 } from 'node:buffer';

import { SAML_LIMITS } from '@pertexo/contracts';
import { DOMParser } from '@xmldom/xmldom';

export const SAML = 'urn:oasis:names:tc:SAML:2.0';
export const SAML_ASSERTION = `${SAML}:assertion`;
export const SAML_PROTOCOL = `${SAML}:protocol`;
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const canonicalization = new Set([
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/2001/10/xml-exc-c14n#WithComments',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments',
]);
const signatures = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
]);
const digests = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);

export function invalidSaml(): never {
  throw new Error('SAML identity proof is invalid');
}
function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}
export function children(
  parent: Element,
  namespace: string,
  name: string,
): Element[] {
  return Array.from(parent.childNodes)
    .filter(isElement)
    .filter(
      (node) => node.namespaceURI === namespace && node.localName === name,
    );
}
export function onlyChild(
  parent: Element,
  namespace: string,
  name: string,
): Element {
  const found = children(parent, namespace, name);
  return found.length === 1 && found[0] !== undefined
    ? found[0]
    : invalidSaml();
}
export function plainText(element: Element): string {
  if (Array.from(element.childNodes).some(isElement)) return invalidSaml();
  return element.textContent;
}
export function requiredAttribute(element: Element, name: string): string {
  const value = element.getAttribute(name);
  return value === null || value.length === 0 ? invalidSaml() : value;
}

/** Reject recovery/ambiguous XML before the signature library sees the same bytes. */
export function parseXml(xml: string): Document {
  if (Buffer.byteLength(xml) > SAML_LIMITS.xmlBytes) return invalidSaml();
  const document = new DOMParser({
    errorHandler: {
      warning: invalidSaml,
      error: invalidSaml,
      fatalError: invalidSaml,
    },
  }).parseFromString(xml, 'application/xml');
  if (document.doctype !== null) return invalidSaml();
  const pending: { node: Node; depth: number }[] = [
    { node: document, depth: 0 },
  ];
  const ids = new Set<string>();
  let nodes = 0,
    elements = 0;
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    if (++nodes > SAML_LIMITS.nodes || current.depth > SAML_LIMITS.depth)
      return invalidSaml();
    if (isElement(current.node)) {
      if (
        ++elements > SAML_LIMITS.elements ||
        current.node.attributes.length > SAML_LIMITS.attributes
      )
        return invalidSaml();
      for (const attribute of Array.from(current.node.attributes)) {
        if (!['ID', 'Id', 'id'].includes(attribute.localName)) continue;
        if (ids.has(attribute.value) || attribute.value.length === 0)
          return invalidSaml();
        ids.add(attribute.value);
      }
    }
    for (
      let child = current.node.lastChild;
      child !== null;
      child = child.previousSibling
    )
      pending.push({ node: child, depth: current.depth + 1 });
  }
  if (elements === 0) return invalidSaml();
  return document;
}
export function root(
  document: Document,
  namespace: string,
  name: string,
): Element {
  const element = document.documentElement;
  if (element.namespaceURI !== namespace || element.localName !== name)
    return invalidSaml();
  return element;
}

/** The SDK owns cryptography; its outbound algorithm option does not restrict incoming signatures. */
export function requireModernSignature(parent: Element) {
  const signature = onlyChild(parent, DSIG, 'Signature');
  const info = onlyChild(signature, DSIG, 'SignedInfo');
  if (
    !signatures.has(
      requiredAttribute(onlyChild(info, DSIG, 'SignatureMethod'), 'Algorithm'),
    ) ||
    !canonicalization.has(
      requiredAttribute(
        onlyChild(info, DSIG, 'CanonicalizationMethod'),
        'Algorithm',
      ),
    )
  )
    return invalidSaml();
  const reference = onlyChild(info, DSIG, 'Reference');
  if (
    requiredAttribute(reference, 'URI') !==
      `#${requiredAttribute(parent, 'ID')}` ||
    !digests.has(
      requiredAttribute(
        onlyChild(reference, DSIG, 'DigestMethod'),
        'Algorithm',
      ),
    )
  )
    return invalidSaml();
  const transforms = children(
    onlyChild(reference, DSIG, 'Transforms'),
    DSIG,
    'Transform',
  );
  if (transforms.length === 0 || transforms.length > 3) return invalidSaml();
  for (const transform of transforms) {
    const algorithm = requiredAttribute(transform, 'Algorithm');
    if (
      algorithm !== `${DSIG}enveloped-signature` &&
      !canonicalization.has(algorithm)
    )
      return invalidSaml();
  }
}

export function decodeResponse(value: string): string {
  const invalidEncodedResponse =
    value.length === 0 ||
    value.length > SAML_LIMITS.encodedCharacters ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value);
  if (invalidEncodedResponse) return invalidSaml();
  const buffer = Buffer.from(value, 'base64');
  if (
    buffer.length > SAML_LIMITS.xmlBytes ||
    buffer.toString('base64') !== value ||
    !isUtf8(buffer)
  )
    return invalidSaml();
  return new TextDecoder().decode(buffer);
}
