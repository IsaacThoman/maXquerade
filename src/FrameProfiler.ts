export const FRAME_TIMING_KEYS = [
  'raf',
  'frame',
  'physics',
  'player',
  'enemy',
  'overlay',
  'render',
  'render.world',
  'render.mask',
  'render.enemies',
  'render.enemies.unmasked',
  'render.enemies.masked',
  'render.overlay',
] as const

export type FrameTimingKey = (typeof FRAME_TIMING_KEYS)[number]

class RollingAverage {
  private readonly values: Float64Array
  private index = 0
  private count = 0
  private sum = 0

  constructor(windowSize: number) {
    const size = Math.max(1, Math.floor(windowSize))
    this.values = new Float64Array(size)
  }

  add(value: number): void {
    const outgoing = this.values[this.index]
    this.sum -= outgoing

    this.values[this.index] = value
    this.sum += value

    this.index = (this.index + 1) % this.values.length
    this.count = Math.min(this.values.length, this.count + 1)
  }

  mean(): number {
    if (this.count === 0) return 0
    return this.sum / this.count
  }
}

export class FrameProfiler {
  private readonly windows: Record<FrameTimingKey, RollingAverage>

  constructor(options: { windowSize?: number } = {}) {
    const windowSize = options.windowSize ?? 60

    const entries = FRAME_TIMING_KEYS.map((key) => [key, new RollingAverage(windowSize)] as const)
    this.windows = Object.fromEntries(entries) as Record<FrameTimingKey, RollingAverage>
  }

  add(key: FrameTimingKey, ms: number): void {
    if (!Number.isFinite(ms)) return
    if (ms < 0) return
    this.windows[key].add(ms)
  }

  snapshot(): Record<FrameTimingKey, number> {
    const out = {} as Record<FrameTimingKey, number>
    for (const key of FRAME_TIMING_KEYS) {
      out[key] = this.windows[key].mean()
    }
    return out
  }
}
