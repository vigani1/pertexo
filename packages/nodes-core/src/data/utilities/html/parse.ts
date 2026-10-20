import { DomHandler, type ChildNode } from 'domhandler';
import { Parser } from 'htmlparser2';
import { refuseUtility } from '../result.js';

class BoundedDomHandler extends DomHandler {
  private members = 0;
  public constructor(private readonly signal: AbortSignal) {
    super();
  }
  private count(count: number) {
    this.signal.throwIfAborted();
    this.members += count;
    if (this.members > 8_000)
      refuseUtility(
        'html_size',
        'The HTML has too many elements, attributes or text nodes. Split the document.',
      );
  }
  protected override addNode(node: ChildNode) {
    this.count(1);
    super.addNode(node);
  }
  public override onopentag(name: string, attributes: Record<string, string>) {
    if (this.tagStack.length > 48)
      refuseUtility(
        'html_depth',
        'The HTML is nested too deeply. Use a smaller document.',
      );
    this.count(Object.keys(attributes).length);
    super.onopentag(name, attributes);
  }
}

export function parseBoundedHtml(value: string, signal: AbortSignal) {
  const handler = new BoundedDomHandler(signal);
  new Parser(handler, { decodeEntities: true }).end(value);
  return handler.dom;
}
