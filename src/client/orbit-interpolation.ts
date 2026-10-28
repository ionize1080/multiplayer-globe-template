export type OrbitSample = { time: number; position: number[]; velocity: number[] };
type Window = { a: OrbitSample; b: OrbitSample; c: OrbitSample | null };

/** Wall-clock keyframes, prefetched ahead of display. No delayed snapshots or extrapolation. */
export class OrbitInterpolator {
  private windows: (Window | null)[];
  private retryAt: Float64Array;
  private cursor = 0;
  constructor(
    readonly count: number,
    private readonly sample: (index: number, time: number) => OrbitSample | null,
    readonly interval = 15_000,
  ) {
    this.windows = Array(count).fill(null);
    this.retryAt = new Float64Array(count);
  }

  update(now: number, budget = 80) {
    for (let visited = 0; visited < this.count && budget > 0; visited++) {
      const i = this.cursor;
      this.cursor = (i + 1) % this.count;
      let w = this.windows[i];
      if (w && now >= w.b.time && w.c) {
        w = this.windows[i] = { a: w.b, b: w.c, c: null };
      }
      if (w && (now < w.a.time || now >= w.b.time)) w = this.windows[i] = null;
      if (!w) {
        if (now < this.retryAt[i]) continue;
        const base = Math.floor(now / this.interval) * this.interval;
        const a = this.sample(i, base);
        const b = a && this.sample(i, base + this.interval);
        budget--;
        if (a && b) this.windows[i] = { a, b, c: null };
        else this.retryAt[i] = now + this.interval;
      } else if (!w.c && now >= w.a.time + this.interval / 2) {
        if (now < this.retryAt[i]) continue;
        w.c = this.sample(i, w.b.time + this.interval);
        budget--;
        if (!w.c) this.retryAt[i] = now + this.interval;
      }
    }
  }

  /** Pack only valid positions; failed propagations never produce a dot at 0°,0°. */
  render(now: number, output: Float32Array): number {
    let count = 0;
    for (const w of this.windows) {
      if (!w) continue;
      const a = now >= w.b.time && w.c ? w.b : w.a;
      const b = now >= w.b.time && w.c ? w.c : w.b;
      if (now < a.time || now > b.time) continue;
      hermitePosition(a, b, now, output, count * 3);
      count++;
    }
    return count;
  }
}

export function hermitePosition(a: OrbitSample, b: OrbitSample, now: number, out: Float32Array, offset = 0) {
  const seconds = (b.time - a.time) / 1000;
  const t = Math.min(1, Math.max(0, (now - a.time) / (b.time - a.time)));
  const t2 = t * t, t3 = t2 * t;
  for (let j = 0; j < 3; j++) {
    out[offset + j] = (2 * t3 - 3 * t2 + 1) * a.position[j] +
      (t3 - 2 * t2 + t) * seconds * a.velocity[j] +
      (-2 * t3 + 3 * t2) * b.position[j] +
      (t3 - t2) * seconds * b.velocity[j];
  }
}
