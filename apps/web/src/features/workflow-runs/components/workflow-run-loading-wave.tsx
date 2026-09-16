import { useEffect, useRef } from 'react';

const GRID_GAP = 24;
const BASE_DOT_RADIUS = 1;
const WAVE_DURATION_MS = 3_400;
const WAVE_WIDTH = 82;
const WAVE_HEIGHT = 11;
const MAX_DEVICE_PIXEL_RATIO = 2;

type CanvasSize = Readonly<{
  width: number;
  height: number;
  pixelRatio: number;
}>;

function getCanvasSize(element: HTMLElement): CanvasSize {
  const bounds = element.getBoundingClientRect();
  return {
    width: bounds.width,
    height: bounds.height,
    pixelRatio: Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO),
  };
}

function resizeCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  size: CanvasSize,
) {
  canvas.width = Math.round(size.width * size.pixelRatio);
  canvas.height = Math.round(size.height * size.pixelRatio);
  context.setTransform(size.pixelRatio, 0, 0, size.pixelRatio, 0, 0);
}

function forEachGridPoint(
  size: CanvasSize,
  callback: (x: number, y: number) => void,
) {
  const xOffset = (size.width % GRID_GAP) / 2;
  const yOffset = (size.height % GRID_GAP) / 2;
  for (let y = yOffset; y <= size.height; y += GRID_GAP) {
    for (let x = xOffset; x <= size.width; x += GRID_GAP) callback(x, y);
  }
}

function drawDot(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
) {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

function drawBaseGrid(context: CanvasRenderingContext2D, size: CanvasSize) {
  context.clearRect(0, 0, size.width, size.height);
  forEachGridPoint(size, (x, y) => {
    drawDot(context, x, y, BASE_DOT_RADIUS, 'rgba(185, 214, 219, 0.12)');
  });
}

function smoothstep(edgeStart: number, edgeEnd: number, value: number) {
  const progress = Math.min(
    1,
    Math.max(0, (value - edgeStart) / (edgeEnd - edgeStart)),
  );
  return progress * progress * (3 - 2 * progress);
}

function drawWaveFrame(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  progress: number,
) {
  context.clearRect(0, 0, size.width, size.height);
  const centerX = size.width / 2;
  const centerY = size.height / 2;
  const crestRadius = progress * (Math.hypot(centerX, centerY) + WAVE_WIDTH);
  const cycleOpacity =
    smoothstep(0, 0.08, progress) * (1 - smoothstep(0.86, 1, progress));

  forEachGridPoint(size, (x, y) => {
    const distanceFromCrest =
      Math.hypot(x - centerX, y - centerY) - crestRadius;
    if (Math.abs(distanceFromCrest) > WAVE_WIDTH) return;
    const normalizedDistance = distanceFromCrest / WAVE_WIDTH;
    const waveHeight =
      Math.cos(normalizedDistance * Math.PI * 2.35) *
      Math.exp(-normalizedDistance * normalizedDistance * 3.2) *
      cycleOpacity;
    const crestStrength = Math.max(0, waveHeight);
    const troughStrength = Math.max(0, -waveHeight);
    const radius = Math.max(
      0.75,
      BASE_DOT_RADIUS + crestStrength * 0.75 - troughStrength * 0.15,
    );
    const liftedY = y - waveHeight * WAVE_HEIGHT;
    const red = Math.round(96 + crestStrength * 64);
    const green = Math.round(184 + crestStrength * 54);
    const blue = Math.round(197 + crestStrength * 45);
    const color = [red, green, blue, 0.16 + Math.abs(waveHeight) * 0.58].join(
      ', ',
    );
    drawDot(context, x, liftedY, radius, `rgba(${color})`);
  });
}

export function WorkflowRunLoadingWave() {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const baseCanvas = baseCanvasRef.current;
    const waveCanvas = waveCanvasRef.current;
    if (container === null || baseCanvas === null || waveCanvas === null)
      return;
    const baseContext = baseCanvas.getContext('2d');
    const waveContext = waveCanvas.getContext('2d');
    if (baseContext === null || waveContext === null) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let size = getCanvasSize(container);
    let animationFrame = 0;

    const render = (timestamp: number) => {
      drawWaveFrame(
        waveContext,
        size,
        (timestamp % WAVE_DURATION_MS) / WAVE_DURATION_MS,
      );
      animationFrame = window.requestAnimationFrame(render);
    };
    const start = () => {
      window.cancelAnimationFrame(animationFrame);
      if (reducedMotion.matches) {
        drawWaveFrame(waveContext, size, 0.34);
        return;
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    const resize = () => {
      size = getCanvasSize(container);
      resizeCanvas(baseCanvas, baseContext, size);
      resizeCanvas(waveCanvas, waveContext, size);
      drawBaseGrid(baseContext, size);
      if (reducedMotion.matches) drawWaveFrame(waveContext, size, 0.34);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    reducedMotion.addEventListener('change', start);
    resize();
    start();
    return () => {
      resizeObserver.disconnect();
      reducedMotion.removeEventListener('change', start);
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      <canvas
        ref={baseCanvasRef}
        className="absolute inset-0 size-full"
        aria-hidden="true"
      />
      <canvas
        ref={waveCanvasRef}
        className="absolute inset-0 size-full"
        aria-hidden="true"
      />
    </div>
  );
}
