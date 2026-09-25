import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  editorHandlers,
  editorPath,
  findCanvas,
  graphWithMappingNodes,
  manualDefinition,
  mappingDefinition,
} from '../support/workflow-editor-fixtures';

/**
 * jsdom lays nothing out, so React Flow never measures a step. This gives
 * every step card a size and reports it the way a browser's ResizeObserver
 * would, and puts the originals back afterwards.
 */
function measureStepCards(size: Readonly<{ width: number; height: number }>) {
  const observer = globalThis.ResizeObserver;
  const width = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  );
  const height = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  );
  const measured = (element: HTMLElement, value: number) =>
    element.classList.contains('react-flow__node') ? value : 0;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return measured(this, size.width);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return measured(this, size.height);
    },
  });
  const matrix = Reflect.get(window, 'DOMMatrixReadOnly') as unknown;
  // React Flow reads the zoom from the viewport's transform.
  Reflect.set(
    window,
    'DOMMatrixReadOnly',
    class ScaleOnlyMatrix {
      public readonly m22: number;
      public constructor(transform?: string) {
        const scale = /scale\(([\d.]+)\)/u.exec(transform ?? '')?.[1];
        this.m22 = scale === undefined ? 1 : Number(scale);
      }
    },
  );
  globalThis.ResizeObserver = class ImmediateResizeObserver {
    readonly #callback: ResizeObserverCallback;
    public constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    public observe(target: Element) {
      if (!target.classList.contains('react-flow__node')) return;
      queueMicrotask(() => {
        this.#callback([{ target } as unknown as ResizeObserverEntry], this);
      });
    }
    public unobserve() {
      return undefined;
    }
    public disconnect() {
      return undefined;
    }
  };
  return () => {
    globalThis.ResizeObserver = observer;
    Reflect.set(window, 'DOMMatrixReadOnly', matrix);
    if (width !== undefined)
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    if (height !== undefined)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
  };
}

describe('workflow editor overview map', { timeout: 30_000 }, () => {
  let restore: () => void = () => undefined;
  beforeEach(() => {
    restore = measureStepCards({ width: 224, height: 64 });
  });
  afterEach(() => {
    restore();
  });

  it('draws every step on the overview map in its family colour', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes(),
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(editorPath);
    await findCanvas();
    const map = await screen.findByRole('img', { name: 'Workflow overview' });
    await waitFor(() => {
      expect(map.querySelectorAll('.react-flow__minimap-node')).toHaveLength(2);
    });
    const fills = [
      ...map.querySelectorAll<SVGRectElement>('.react-flow__minimap-node'),
    ].map((node) => node.getAttribute('style') ?? '');
    expect(fills[0]).toContain('var(--primary)');
    expect(fills[1]).toContain('var(--success)');
  });
});

describe('workflow editor command bar', { timeout: 30_000 }, () => {
  it('folds undo, redo and the shortcuts into ⋯ for narrow screens', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes(),
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    const canvas = await findCanvas();
    fireEvent.click(canvas.getByText('Target'));
    screen.getByRole('region', { name: 'Workflow canvas' }).focus();
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    await waitFor(() => {
      expect(canvas.getAllByText('Target')).toHaveLength(2);
    });

    await event.click(
      screen.getByRole('button', { name: 'More editor actions' }),
    );
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).getByRole('menuitem', { name: /Redo/u }),
    ).toHaveAttribute('aria-disabled', 'true');
    await event.click(within(menu).getByRole('menuitem', { name: /Undo/u }));
    await waitFor(() => {
      expect(canvas.getAllByText('Target')).toHaveLength(1);
    });

    await event.click(
      screen.getByRole('button', { name: 'More editor actions' }),
    );
    await event.click(
      await screen.findByRole('menuitem', { name: /Keyboard shortcuts/u }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Keyboard shortcuts' }),
    ).toBeVisible();
  });
});
