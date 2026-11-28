import { encode } from 'uqr';

const QUIET_ZONE_MODULES = 4;

export function QrCode({
  value,
  label,
}: Readonly<{ value: string; label: string }>) {
  const { data, size } = encode(value);
  const extent = size + QUIET_ZONE_MODULES * 2;
  // A fixed black-on-white quiet zone keeps the code scannable in both themes.
  const path = data
    .flatMap((row, y) =>
      row.flatMap((dark, x) =>
        dark
          ? [
              `M${String(x + QUIET_ZONE_MODULES)} ${String(y + QUIET_ZONE_MODULES)}h1v1h-1z`,
            ]
          : [],
      ),
    )
    .join('');

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(extent)} ${String(extent)}`}
      className="size-48 max-w-full"
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}
