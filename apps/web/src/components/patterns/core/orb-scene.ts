import {
  CanvasScene,
  readTokenColor,
  rgba,
  type Rgb,
} from '@/lib/canvas-scene';

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

// Palettes come from the Core's own design tokens so the orb never drifts
// from the theme: a state's ink leads, a glint or accent highlights.
const PALETTE_TOKENS: Record<CoreOrbState, readonly [string, string, string]> =
  {
    live: ['--core-live', '--core-glint', '--core-accent'],
    idle: ['--core-live', '--core-glint', '--core-accent'],
    waiting: ['--core-waiting', '--core-accent', '--core-waiting'],
    failed: ['--core-failed', '--core-failed', '--destructive'],
    succeeded: ['--core-succeeded', '--success', '--core-live'],
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

// Dark draws points of light: a bright centre with a short falloff. Light
// draws beads of dye: a solid body with a soft rim, so on pale cloth a
// particle reads as a crisp bead rather than a smudge.
const SPRITE_STOPS = {
  light: [
    [0, 1],
    [0.18, 0.8],
    [0.45, 0.18],
    [1, 0],
  ],
  ink: [
    [0, 1],
    [0.34, 0.95],
    [0.52, 0.42],
    [0.74, 0.08],
    [1, 0],
  ],
} as const;

function particleSprite({
  rgb,
  ink,
}: Readonly<{ rgb: Rgb; ink: boolean }>): HTMLCanvasElement {
  const key = `${rgb.join(',')}${ink ? ':ink' : ''}`;
  const cached = spriteCache.get(key);
  if (cached !== undefined) return cached;
  const sprite = document.createElement('canvas');
  sprite.width = 64;
  sprite.height = 64;
  const context = sprite.getContext('2d');
  if (context !== null) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (const [offset, alpha] of SPRITE_STOPS[ink ? 'ink' : 'light'])
      gradient.addColorStop(offset, rgba(rgb, alpha));
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  spriteCache.set(key, sprite);
  return sprite;
}

// A large Core needs more, finer particles, or its grain turns into blurry
// dots: the count grows with its size and each particle's size is capped.
// Past 2,400 the shell barely gets denser, but every frame draws them all.
const MAX_PARTICLES = 2400;
const MAX_PARTICLE_SIZE = 3.2;
const SMALL_CORE_SIZE = 140;

function particleCountFor(cssSize: number): number {
  if (cssSize <= 48) return 150;
  if (cssSize <= SMALL_CORE_SIZE) return 520;
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
  /** Light only: a faint dyed glow, so the Core has its own light on cloth. */
  #halo: Rgb | undefined;
  #energy = 1;
  #assemblyStart: number | undefined;

  constructor(canvas: HTMLCanvasElement, state: CoreOrbState) {
    super(canvas);
    this.setState(state);
  }

  setState(state: CoreOrbState): void {
    this.#motion = MOTION[state];
    // Light composes normally: there are no points of light on white.
    const ink = this.particleComposition === 'source-over';
    const palette = PALETTE_TOKENS[state].map((token) =>
      readTokenColor(token, FALLBACK_RGB),
    );
    this.#sprites = palette.map((rgb) => particleSprite({ rgb, ink }));
    this.#halo = ink ? (palette[1] ?? FALLBACK_RGB) : undefined;
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
    context.globalCompositeOperation = this.particleComposition;
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
    if (this.#halo !== undefined) {
      context.globalCompositeOperation = 'source-over';
      const glow = context.createRadialGradient(
        centreX,
        centreY,
        radius * 0.2,
        centreX,
        centreY,
        half,
      );
      glow.addColorStop(0, rgba(this.#halo, 0.2 * assembly));
      glow.addColorStop(0.6, rgba(this.#halo, 0.08 * assembly));
      glow.addColorStop(1, rgba(this.#halo, 0));
      context.fillStyle = glow;
      context.fillRect(0, 0, this.width, this.height);
      context.globalCompositeOperation = this.particleComposition;
    }
    // Dye only deepens where it overlaps, so a large Core's dense shell takes
    // finer beads or it knots into a dark rim. A small Core has few particles
    // and needs full beads, a little stronger, to read at all.
    const dense = Math.min(this.width, this.height) > SMALL_CORE_SIZE;
    const beadScale = this.#halo === undefined || !dense ? 1 : 0.6;
    const strength = this.#halo === undefined || dense ? 1 : 1.35;

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
      const size = baseSize * beadScale * (1 + seed * 1.2) * perspective;
      const sprite = this.#sprites[particle.swatch] ?? this.#sprites[0];
      if (sprite === undefined) return;
      context.globalAlpha = Math.min(1, alpha * strength);
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
      swatch: particleSwatch(pick),
    };
  });
}

function particleSwatch(pick: number): Particle['swatch'] {
  return pick < 0.68 ? 0 : pick < 0.88 ? 1 : 2;
}
