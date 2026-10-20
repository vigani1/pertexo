import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

const descriptions = {
  'http.pagination_origin_changed':
    'The next page points to another origin. Pagination can only follow the original service.',
  'http.pagination_too_large':
    'The combined pages exceed the step output limits. Lower Max pages or narrow the request.',
  'http.pagination_invalid_page':
    'The page must contain valid JSON and a list at the Items path, within the inline response limit.',
  'http.pagination_invalid_navigation':
    'The next link or cursor is invalid or too large. Check the pagination settings and the service response.',
  'http.pagination_budget_exceeded':
    'Max pages, timeout and delay cannot fit the remaining run or test time. Lower Max pages, timeout or delay.',
} as const;
export class HttpPaginationFailure extends NodeExecutorFailure {
  public override readonly name = 'HttpPaginationFailure';
  public constructor(
    public readonly code: keyof typeof descriptions,
    public readonly page: number,
  ) {
    super({
      kind: 'failed',
      errorKind:
        code === 'http.pagination_budget_exceeded'
          ? 'configuration'
          : 'provider',
      possiblyDispatched: false,
      safeErrorCode: code,
      errorSummary: `Page ${String(page)}: ${descriptions[code]}`,
    });
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw new TypeError('Invalid pagination page');
  }
  public get summary(): string {
    return `Page ${String(this.page)}: ${descriptions[this.code]}`;
  }
}
