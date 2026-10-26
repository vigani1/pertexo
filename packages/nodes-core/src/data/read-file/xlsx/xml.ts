import { setImmediate } from 'node:timers/promises';
import { Parser } from 'htmlparser2';
import { unsupported } from './archive.js';
import { SPREADSHEET_LIMITS } from './limits.js';

export type XmlAttributes = Readonly<Record<string, string | undefined>>;
export type XmlVisitor = Readonly<{
  open?(name: string, attributes: XmlAttributes): void;
  text?(text: string): void;
  close?(name: string): void;
}>;

const PIECE = 16_384;

/**
 * Streams one workbook part through htmlparser2, which expands no DTD or
 * custom entity. Names lose their namespace prefix, as writers differ. It
 * yields after each piece so a caller can pass on what the visitor collected.
 */
export async function* readXmlPart(
  chunks: AsyncIterable<Uint8Array>,
  visitor: XmlVisitor,
  signal: AbortSignal,
): AsyncGenerator<void> {
  const parser = guardedParser(visitor);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sinceYield = 0;
  for await (const chunk of chunks) {
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: true });
    } catch {
      return unsupported();
    }
    for (let offset = 0; offset < text.length; offset += PIECE) {
      signal.throwIfAborted();
      parser.write(text.slice(offset, offset + PIECE));
      yield;
    }
    sinceYield += chunk.byteLength;
    if (sinceYield >= 65_536) {
      await setImmediate(undefined, { signal });
      sinceYield = 0;
    }
  }
  let rest: string;
  try {
    rest = decoder.decode();
  } catch {
    return unsupported();
  }
  parser.write(rest);
  parser.end();
  yield;
}

/** Reads a whole part for a visitor that keeps what it needs. */
export async function readXml(
  chunks: AsyncIterable<Uint8Array>,
  visitor: XmlVisitor,
  signal: AbortSignal,
): Promise<void> {
  for await (const _ of readXmlPart(chunks, visitor, signal));
}

/**
 * htmlparser2 keeps an unfinished tag, attribute value or comment whole until
 * it ends, so bound how much input may pass without a parser event, along
 * with depth and attributes per element.
 */
function guardedParser(visitor: XmlVisitor) {
  let pending = 0,
    depth = 0,
    attributes = 0;
  const seen = () => {
    pending = 0;
  };
  const parser = new Parser(
    {
      onopentagname: () => {
        seen();
        attributes = 0;
      },
      onattribute: () => {
        seen();
        if (++attributes > SPREADSHEET_LIMITS.xmlAttributes) unsupported();
      },
      onopentag: (name, values) => {
        seen();
        if (++depth > SPREADSHEET_LIMITS.xmlDepth) unsupported();
        visitor.open?.(localName(name), localAttributes(values));
      },
      onclosetag: (name) => {
        seen();
        depth--;
        visitor.close?.(localName(name));
      },
      ontext: (text) => {
        seen();
        visitor.text?.(text);
      },
      oncomment: seen,
      oncdatastart: seen,
      onprocessinginstruction: seen,
    },
    { xmlMode: true, decodeEntities: true },
  );
  return {
    write(text: string) {
      pending += text.length;
      if (pending > SPREADSHEET_LIMITS.xmlPendingLength) unsupported();
      parser.write(text);
    },
    end: () => {
      parser.end();
    },
  };
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

function localAttributes(values: Record<string, string>): XmlAttributes {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([name]) => name !== 'xmlns' && !name.startsWith('xmlns:'))
      .map(([name, value]) => [localName(name), value]),
  );
}
