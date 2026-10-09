import { CanvasScene, readTokenColor, type Rgb } from '@/lib/canvas-scene';

// Canvas 2D port of the legacy particle-orb shader: points on a Fibonacci
// sphere, displaced by three travelling waves, rotated and projected with a
// soft additive sprite. Pure drawing code; the React component owns lifecycle.

export type CoreOrbState = 'live' | 'idle' | 'waiting' | 'failed' | 'succeeded';

type Motion = Readonly<{
  speed: number;
  amplitude: number;
  loosen: boolean;
  /** Brightness: a settled run's Core moves less, so it glows more. */
  glow: number;
}>;

const MOTION: Record<CoreOrbState, Motion> = {
  live: { speed: 1, amplitude: 1, loosen: false, glow: 1 },
  idle: { speed: 0.6, amplitude: 0.4, loosen: false, glow: 1 },
  waiting: { speed: 0.45, amplitude: 0.55, loosen: false, glow: 1.3 },
  failed: { speed: 0.35, amplitude: 0.7, loosen: true, glow: 1.35 },
  succeeded: { speed: 0.5, amplitude: 0.45, loosen: false, glow: 1.25 },
};

// Palettes come from the design tokens so the orb never drifts from the
// theme: a state's own Core ink leads, its paler text colour highlights.
const PALETTE_TOKENS: Record<CoreOrbState, readonly [string, string, string]> =
  {
    live: ['--primary', '--accent-foreground', '--secondary'],
    idle: ['--primary', '--accent-foreground', '--secondary'],
    waiting: ['--core-waiting', '--secondary', '--core-waiting'],
    failed: ['--core-failed', '--core-failed', '--destructive'],
    succeeded: ['--core-succeeded', '--success', '--primary'],
  };

const FALLBACK_RGB: Rgb = [0, 229, 255];
const CAMERA_DISTANCE = 2.5;
const ASSEMBLY_SECONDS = 1.5;
// Past this share of the way from the centre to the canvas's nearest edge,
// particles fade out, so the Core never shows the square it's drawn in.
const EDGE_FADE_START = 0.85;

interface Particle {
  x: number;
  y: number;
  z: number;
  seed: number;
  swatch: number;
}

const spriteCache = new Map<string, HTMLCanvasElement>();

function particleSprite(rgb: Rgb): HTMLCanvasElement {
  const key = rgb.join(',');
  const cached = spriteCache.get(key);
  if (cached !== undefined) return cached;
  const sprite = document.createElement('canvas');
  sprite.width = 64;
  sprite.height = 64;
  const context = sprite.getContext('2d');
  if (context !== null) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    // A bright core with a short falloff: a point of light, not a blur.
    gradient.addColorStop(0, `rgba(${key},1)`);
    gradient.addColorStop(0.18, `rgba(${key},0.8)`);
    gradient.addColorStop(0.45, `rgba(${key},0.18)`);
    gradient.addColorStop(1, `rgba(${key},0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  spriteCache.set(key, sprite);
  return sprite;
}

// A large Core needs more, finer particles, or its grain turns into blurry
// dots: the count grows with its size and each particle's size is capped.
const MAX_PARTICLES = 4200;
const MAX_PARTICLE_SIZE = 3.2;

function particleCountFor(cssSize: number): number {
  if (cssSize <= 48) return 150;
  if (cssSize <= 140) return 520;
  return Math.min(MAX_PARTICLES, Math.round(1400 * (cssSize / 180) ** 1.6));
}

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

export class CoreOrbScene extends CanvasScene {
  #particles: Particle[] = [];
  #scatter: readonly (readonly [number, number])[] = [];
  #sprites: readonly HTMLCanvasElement[] = [];
  #motion: Motion = MOTION.live;
  #energy = 1;
  #assemblyStart: number | undefined;

  constructor(canvas: HTMLCanvasElement, state: CoreOrbState) {
    super(canvas);
    this.setState(state);
  }

  setState(state: CoreOrbState): void {
    this.#motion = MOTION[state];
    this.#sprites = PALETTE_TOKENS[state].map((token) =>
      particleSprite(readTokenColor(token, FALLBACK_RGB)),
    );
  }

  setEnergy(energy: number): void {
    this.#energy = Math.min(1.6, Math.max(0.2, energy));
  }

  /**
   * Scatter the particles off-centre so the next frames gather them in. Some
   * start past the edge fade: they arrive out of the dark.
   */
  assemble(timeSeconds: number): void {
    this.#assemblyStart = timeSeconds;
    const half = Math.min(this.width, this.height) / 2;
    this.#scatter = this.#particles.map(() => {
      const angle = Math.random() * Math.PI * 2;
      const radius = half * (0.35 + Math.random() * 0.9);
      return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const;
    });
  }

  override resize(width: number, height: number, pixelRatio: number): void {
    super.resize(width, height, pixelRatio);
    const count = particleCountFor(Math.min(width, height));
    if (count !== this.#particles.length)
      this.#particles = createParticles(count);
  }

  render(timeSeconds: number): void {
    const context = this.beginFrame();
    context.globalCompositeOperation = 'lighter';
    const half = Math.min(this.width, this.height) / 2;
    const radius = half * 0.72;
    const centreX = this.width / 2;
    const centreY = this.height / 2;
    const time = timeSeconds * this.#motion.speed;
    const amplitude = this.#motion.amplitude * this.#energy;
    const cosY = Math.cos(time * 0.1);
    const sinY = Math.sin(time * 0.1);
    const cosX = Math.cos(time * 0.05);
    const sinX = Math.sin(time * 0.05);
    const breathe = 0.95 + Math.sin(time * 0.5) * 0.05 * amplitude;
    const baseSize = Math.min(MAX_PARTICLE_SIZE, Math.max(1.1, radius / 34));
    const assembly = this.#assemblyProgress(timeSeconds);

    this.#particles.forEach((particle, index) => {
      const { x, y, z, seed } = particle;
      const wave =
        Math.sin(x * 2 + time * 1.5) * Math.cos(y * 2 + time * 1.2) * 0.15 +
        Math.sin(z * 3 - time * 2) * 0.1 +
        Math.sin(Math.hypot(x, y) * 4 + time) * 0.05;
      let scale = (1 + wave * amplitude) * breathe;
      if (this.#motion.loosen && seed > 0.8)
        scale += (Math.sin(time * 1.3 + seed * 40) * 0.5 + 0.5) * 0.45;
      const rotatedX = x * scale * cosY + z * scale * sinY;
      const rotatedZ = -x * scale * sinY + z * scale * cosY;
      const projectedY = y * scale * cosX - rotatedZ * sinX;
      const depth = y * scale * sinX + rotatedZ * cosX;
      const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - depth * 0.9);
      let screenX = centreX + rotatedX * radius * perspective;
      let screenY = centreY + projectedY * radius * perspective;
      let alpha = Math.max(0.06, 0.35 + 0.55 * Math.sin(time * 2 + seed * 10));
      alpha *= (0.35 + 0.65 * ((depth + 1) / 2)) * this.#motion.glow;
      const offset = this.#scatter[index];
      if (assembly < 1 && offset !== undefined) {
        screenX += offset[0] * (1 - assembly);
        screenY += offset[1] * (1 - assembly);
        alpha *= 0.25 + 0.75 * assembly;
      }
      const reach = Math.hypot(screenX - centreX, screenY - centreY) / half;
      if (reach > EDGE_FADE_START)
        alpha *= Math.max(0, (1 - reach) / (1 - EDGE_FADE_START));
      if (alpha <= 0) return;
      const size = baseSize * (1 + seed * 1.2) * perspective;
      const sprite = this.#sprites[particle.swatch] ?? this.#sprites[0];
      if (sprite === undefined) return;
      context.globalAlpha = Math.min(1, alpha);
      context.drawImage(
        sprite,
        screenX - size,
        screenY - size,
        size * 2,
        size * 2,
      );
    });

    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }

  #assemblyProgress(timeSeconds: number): number {
    if (this.#assemblyStart === undefined) return 1;
    const progress = (timeSeconds - this.#assemblyStart) / ASSEMBLY_SECONDS;
    if (progress >= 1) {
      this.#assemblyStart = undefined;
      return 1;
    }
    return easeOutCubic(Math.max(0, progress));
  }
}

function createParticles(count: number): Particle[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, index) => {
    const y = 1 - (2 * (index + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    const theta = goldenAngle * index;
    const pick = Math.random();
    return {
      x: Math.cos(theta) * ring,
      y,
      z: Math.sin(theta) * ring,
      seed: Math.random(),
      swatch: pick < 0.68 ? 0 : pick < 0.88 ? 1 : 2,
    };
  });
}
