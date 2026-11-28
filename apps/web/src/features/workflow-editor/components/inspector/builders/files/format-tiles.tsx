import type { ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type FileFormat = 'json' | 'csv' | 'xlsx' | 'text';

const TILES: Readonly<
  Record<FileFormat, Readonly<{ label: string; extension: string }>>
> = {
  json: { label: 'JSON', extension: '.json' },
  csv: { label: 'CSV', extension: '.csv' },
  xlsx: { label: 'Excel', extension: '.xlsx' },
  text: { label: 'Text', extension: '.txt' },
};

/**
 * The file format as a row of tiles, each drawn as a small swatch of its
 * structure. The chosen tile lifts and takes the focus ring's colour; the
 * group keeps one choice, so pressing it again leaves it chosen.
 */
export function FormatTiles({
  id,
  formats,
  value,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  formats: readonly FileFormat[];
  value: string | undefined;
  disabled: boolean;
  onChange: (format: FileFormat) => void;
}>) {
  const labelId = `${id}-label`;
  return (
    <>
      {/* A label element can't name a group of buttons. */}
      <p id={labelId} className="text-label font-semibold text-foreground/85">
        File format
      </p>
      <ToggleGroup
        aria-labelledby={labelId}
        value={value === undefined ? [] : [value]}
        disabled={disabled}
        onValueChange={(values) => {
          const next = formats.find((format) => values.includes(format));
          if (next !== undefined && next !== value) onChange(next);
        }}
        className="grid w-full auto-cols-fr grid-flow-col gap-1.5"
        appearance="frameless"
      >
        {formats.map((format) => (
          <ToggleGroupItem
            key={format}
            value={format}
            aria-label={TILES[format].label}
            appearance="tile"
          >
            <FormatGlyph format={format} />
            <span className="flex items-baseline gap-1 text-label leading-none font-medium">
              {TILES[format].label}
              <span
                aria-hidden="true"
                className="hidden font-mono text-micro font-normal text-subtle-foreground min-[420px]:inline"
              >
                {TILES[format].extension}
              </span>
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>
  );
}

const thread =
  'stroke-surface-ink/30 transition-colors group-data-pressed/tile:stroke-surface-ink/45';
const lit =
  'stroke-subtle-foreground transition-colors group-data-pressed/tile:stroke-action';

/** Each format's structure, woven like the app's other swatches. Decorative. */
function FormatGlyph({ format }: Readonly<{ format: FileFormat }>) {
  const glyphs: Record<FileFormat, ReactNode> = {
    json: (
      <>
        <path
          d="M9 4.5c-2 0-2.5 1-2.5 2.6v2c0 1.2-.6 1.9-1.8 1.9 1.2 0 1.8.7 1.8 1.9v2c0 1.6.5 2.6 2.5 2.6"
          className={lit}
        />
        <path
          d="M19 4.5c2 0 2.5 1 2.5 2.6v2c0 1.2.6 1.9 1.8 1.9-1.2 0-1.8.7-1.8 1.9v2c0 1.6-.5 2.6-2.5 2.6"
          className={lit}
        />
        <path d="M11.5 9h5M11.5 13h3" className={thread} />
      </>
    ),
    csv: (
      <>
        {[6, 11, 16].map((y) => (
          <g key={y}>
            <path
              d={`M4 ${String(y)}h5.5M12.5 ${String(y)}h4.5M20 ${String(y)}h4`}
              className={y === 6 ? lit : thread}
            />
            <circle
              cx={11}
              cy={y + 0.6}
              r={0.7}
              className="fill-subtle-foreground stroke-none"
            />
            <circle
              cx={18.5}
              cy={y + 0.6}
              r={0.7}
              className="fill-subtle-foreground stroke-none"
            />
          </g>
        ))}
      </>
    ),
    xlsx: (
      <>
        <rect
          x={4}
          y={3.5}
          width={20}
          height={14.5}
          rx={2}
          className={thread}
        />
        <path d="M4 8h20" className={lit} strokeWidth={2.2} />
        <path d="M10.5 3.5v14.5M17 3.5v14.5M4 13h20" className={thread} />
        <path d="M5.5 20.5h6" className={lit} strokeWidth={2} />
      </>
    ),
    text: <path d="M4 5.5h20M4 10h17M4 14.5h20M4 19h11" className={thread} />,
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 28 22"
      fill="none"
      strokeWidth={1.4}
      strokeLinecap="round"
      className="size-7 shrink-0"
    >
      {glyphs[format]}
    </svg>
  );
}
