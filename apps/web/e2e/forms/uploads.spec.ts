import { mkdir } from 'node:fs/promises';
import { formConfigSchema } from '@pertexo/workflow-model';
import { test, expect, type Page } from '../support/fixtures';
import { installEditorRoutes, remoteDraft } from '../workflow-editor/support';

const versionId = '22222222-2222-4222-8222-222222222222';
const publicId = '11111111-1111-4111-8111-111111111111';
const capability = 'a'.repeat(43);
const store = 'https://objects.example.test/form-upload';
const form = formConfigSchema.parse({
  title: 'Send your receipts',
  instructions: 'Attach the invoice and up to three photos of the goods.',
  fields: [
    { id: 'name', name: 'name', label: 'Your name', type: 'text' },
    {
      id: 'invoice',
      name: 'invoice',
      label: 'Invoice',
      type: 'file',
      accept: ['documents'],
      help: 'The PDF the supplier sent you.',
    },
    {
      id: 'photos',
      name: 'photos',
      label: 'Photos',
      type: 'file',
      required: false,
      accept: ['images'],
      maxFiles: 3,
      maxBytes: 1_048_576,
    },
  ],
});
const shots = process.env.PERTEXO_FEATURE_SHOTS;

type Upload = Readonly<{ id: string; filename: string; session: string }>;

async function installUploadRoutes(
  page: Page,
  options: Readonly<{ holdPut?: Promise<void> }> = {},
) {
  const uploads: Upload[] = [];
  const submits: { values: unknown; session: string | undefined }[] = [];
  await installEditorRoutes(page, remoteDraft());
  const path = `**/v1/forms/${publicId}`;
  await page.route(path, (route) =>
    route.fulfill({ json: { versionId, form } }),
  );
  await page.route(`${path}/uploads`, async (route) => {
    const request = route.request();
    expect(request.headers()['x-pertexo-form-key']).toBe(capability);
    const body = request.postDataJSON() as {
      filename: string;
      byteLength: number;
      versionId: string;
    };
    expect(body.versionId).toBe(versionId);
    const id = `00000000-0000-4000-8000-${String(uploads.length + 1).padStart(12, '0')}`;
    uploads.push({
      id,
      filename: body.filename,
      session: request.headers()['x-pertexo-form-session'] ?? '',
    });
    await route.fulfill({
      status: 201,
      json: {
        upload: {
          id,
          filename: body.filename,
          byteLength: body.byteLength,
          mediaType: body.filename.endsWith('.pdf')
            ? 'application/pdf'
            : 'image/png',
          status: 'pending',
          expiresAt: '2026-10-26T12:15:00.000Z',
        },
        transfer: {
          method: 'PUT',
          url: `${store}/${id}`,
          headers: { 'content-type': 'application/octet-stream' },
          expiresAt: '2026-10-26T12:15:00.000Z',
          expiresInSeconds: 900,
        },
        replayed: false,
      },
    });
  });
  await page.route(`${store}/*`, async (route) => {
    expect(route.request().method()).toBe('PUT');
    await options.holdPut;
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route(`${path}/uploads/*/finalize`, (route) => {
    const id = route.request().url().split('/').at(-2) ?? '';
    const upload = uploads.find((candidate) => candidate.id === id);
    if (upload?.filename === 'renamed.pdf')
      return route.fulfill({
        status: 415,
        contentType: 'application/problem+json',
        json: {
          type: 'urn:pertexo:problem:form.file_type_not_allowed',
          title: 'File type not allowed',
          status: 415,
          code: 'form.file_type_not_allowed',
          detail:
            'This file’s contents don’t match its .pdf name. Choose the original file.',
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      });
    return route.fulfill({
      json: {
        id,
        filename: upload?.filename ?? 'file',
        byteLength: 9,
        mediaType: 'application/pdf',
        status: 'available',
        expiresAt: '2026-10-27T12:00:00.000Z',
      },
    });
  });
  await page.route(`${path}/submit`, (route) => {
    const request = route.request();
    submits.push({
      values: (request.postDataJSON() as { values: unknown }).values,
      session: request.headers()['x-pertexo-form-session'],
    });
    return route.fulfill({
      json: {
        accepted: true,
        replayed: false,
        thankYouMessage: 'Thanks — your receipts are in.',
      },
    });
  });
  return { uploads, submits };
}

const pdf = (name: string, text = '%PDF-1.7\n') => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from(text),
});
const png = (name: string, size = 64) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size),
  ]),
});

test('a public responder attaches files, sees refusals in place and sends only finished uploads', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const routes = await installUploadRoutes(page);
  await page.goto(`/forms/${publicId}#${capability}`);
  await page.getByLabel('Your name', { exact: true }).fill('Ada');
  const invoice = page.getByLabel('Invoice', { exact: true });
  await expect(invoice).toHaveAccessibleDescription(
    /PDF, Word, text · up to 5 MB.*The PDF the supplier sent you\./u,
  );
  await invoice.setInputFiles(pdf('renamed.pdf', '<html>'));
  const invoiceFiles = page.getByRole('list', { name: 'Invoice files' });
  await expect(
    invoiceFiles.getByText(/contents don’t match its \.pdf name/u),
  ).toBeVisible();
  await invoiceFiles
    .getByRole('button', { name: 'Remove renamed.pdf', exact: true })
    .click();
  await invoice.setInputFiles(pdf('March invoice.pdf'));
  await expect(invoiceFiles.getByText(/Attached/u)).toBeVisible();
  const photos = page.getByLabel('Photos (optional)', { exact: true });
  await photos.setInputFiles([
    png('front.png'),
    png('back.png', 2 * 1_048_576),
  ]);
  const photoFiles = page.getByRole('list', { name: 'Photos files' });
  await expect(
    photoFiles.getByText('This file is 2 MB; the limit is 1 MB.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(photoFiles.getByText(/Attached/u)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Send response', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Response sent', exact: true }),
  ).toBeVisible();
  // Refused files never reached the server; the response names finished uploads only.
  expect(routes.uploads.map(({ filename }) => filename)).toEqual([
    'renamed.pdf',
    'March invoice.pdf',
    'front.png',
  ]);
  const session = routes.uploads[0]?.session;
  expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(routes.uploads.every((upload) => upload.session === session)).toBe(
    true,
  );
  expect(routes.submits).toEqual([
    {
      values: {
        name: 'Ada',
        invoice: [routes.uploads[1]?.id],
        photos: [routes.uploads[2]?.id],
      },
      session,
    },
  ]);
});

test('waits for uploads before sending, and keeps a phone’s drop zone a large target', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  let release: () => void = () => undefined;
  const holdPut = new Promise<void>((resolve) => {
    release = resolve;
  });
  await installUploadRoutes(page, { holdPut });
  await page.goto(`/forms/${publicId}#${capability}`);
  const zone = page.locator('[data-slot="file-drop"]').first();
  const box = await zone.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(96);
  await expect(page.getByText('Choose a file', { exact: true })).toBeVisible();
  await page
    .getByLabel('Invoice', { exact: true })
    .setInputFiles(pdf('slow.pdf'));
  const send = page.getByRole('button', { name: 'Send response', exact: true });
  await expect(send).toBeDisabled();
  await expect(
    page.getByText('Waiting for files to finish uploading.', { exact: true }),
  ).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove slow.pdf' });
  const target = await remove.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(44);
  expect(target?.height).toBeGreaterThanOrEqual(44);
  release();
  await expect(send).toBeEnabled();
});

const sizes = [
  [360, 740],
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
] as const;
for (const scheme of ['light', 'dark'] as const)
  test(`renders the file questions without overflow in ${scheme}`, async ({
    page,
  }) => {
    test.skip(shots === undefined, 'Feature screenshots are opt-in.');
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    let release: () => void = () => undefined;
    const holdPut = new Promise<void>((resolve) => {
      release = resolve;
    });
    await installUploadRoutes(page, { holdPut });
    await page.goto(`/forms/${publicId}#${capability}`);
    await page.getByLabel('Your name', { exact: true }).fill('Ada Lovelace');
    await mkdir(shots ?? '', { recursive: true });
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `${shots ?? ''}/public-empty-${String(width)}x${String(height)}-${scheme}.png`,
        fullPage: true,
      });
    }
    await page
      .getByLabel('Invoice', { exact: true })
      .setInputFiles(pdf('March invoice — Northwind Traders.pdf'));
    await page
      .getByLabel('Photos (optional)', { exact: true })
      .setInputFiles([png('front.png'), png('label.png', 2 * 1_048_576)]);
    await expect(page.getByText(/Sending/u).first()).toBeVisible();
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `${shots ?? ''}/public-sending-${String(width)}x${String(height)}-${scheme}.png`,
        fullPage: true,
      });
    }
    release();
    await expect(
      page.getByRole('list', { name: 'Invoice files' }).getByText(/Attached/u),
    ).toBeVisible();
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${shots ?? ''}/public-attached-${String(width)}x${String(height)}-${scheme}.png`,
        fullPage: true,
      });
    }
  });
