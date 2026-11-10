/**
 * The boot sequence's timing, taken from the boot music itself.
 *
 * The sequence used to run on a fixed clock — rings at 2.6s, suit at 5.2s,
 * reactor at 7.2s — while the music hit wherever its composer put the hits, so
 * the biggest impact in the track landed in the middle of the suit schematic.
 * This decodes the track once, measures its loudness every STEP_MS, and puts
 * each stage change on the strongest onset in a window where that stage makes
 * sense. Swap in a different boot-music.mp3 and the sequence follows it.
 *
 * Everything here is pure except analyseBootTrack, so the cue picking can be
 * tested without a browser.
 */

export const STEP_MS = 50

export type BootCues = {
  /** Reticle rings assemble, the name resolves. */
  rings: number
  /** Suit schematic. */
  suit: number
  /** Arc reactor ignites. */
  reactor: number
  /** The overlay dissolves and the live interface takes over. */
  end: number
}

/** What the sequence runs on when the music cannot be analysed. */
export const DEFAULT_CUES: BootCues = { rings: 2600, suit: 5200, reactor: 7200, end: 9200 }

/** How long the reactor holds at full glow before the hand-off. */
const REACTOR_HOLD_MS = 1900

/**
 * Onset strength per step: how far loudness jumped above the average of the
 * preceding ~400ms, normalised to the loudest moment. Steady loud passages
 * score low; a hit out of quiet scores high, which is what reads as an impact.
 */
export function onsets(envelope: ArrayLike<number>, lookback = 8): number[] {
  let peak = 0
  for (let i = 0; i < envelope.length; i++) peak = Math.max(peak, envelope[i])
  if (peak <= 0) return Array.from({ length: envelope.length }, () => 0)
  const out: number[] = []
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - lookback); j < i; j++) {
      sum += envelope[j]
      n++
    }
    const before = n ? sum / n : 0
    out.push(Math.max(0, envelope[i] - before) / peak)
  }
  return out
}

/** Index of the strongest onset between two times, or -1 if nothing clears `min`. */
function strongest(o: number[], fromMs: number, toMs: number, min: number, step: number): number {
  let best = -1
  let bestV = min
  const a = Math.max(0, Math.floor(fromMs / step))
  const b = Math.min(o.length - 1, Math.ceil(toMs / step))
  for (let i = a; i <= b; i++) {
    if (o[i] > bestV) {
      bestV = o[i]
      best = i
    }
  }
  return best
}

/**
 * Place each stage on a hit. Each stage searches a window after the one
 * before it, so the order always holds and no stage is too short to read;
 * a window with no real hit keeps that stage's default spacing instead.
 */
export function pickCues(envelope: ArrayLike<number>, step = STEP_MS): BootCues {
  const o = onsets(envelope)
  const MIN = 0.12
  const at = (i: number, fallback: number) => (i >= 0 ? i * step : fallback)

  const rings = at(strongest(o, 2000, 6000, MIN, step), DEFAULT_CUES.rings)
  const suit = at(strongest(o, rings + 1000, rings + 3500, MIN, step), rings + 2600)
  const reactor = at(strongest(o, suit + 1500, suit + 5000, MIN, step), suit + 2000)
  return { rings, suit, reactor, end: reactor + REACTOR_HOLD_MS }
}

/** Loudness (RMS) per step from decoded samples. */
export function envelopeOf(samples: Float32Array, sampleRate: number, step = STEP_MS): Float32Array {
  const w = Math.max(1, Math.round((sampleRate * step) / 1000))
  const out = new Float32Array(Math.floor(samples.length / w))
  for (let k = 0; k < out.length; k++) {
    let sum = 0
    for (let i = k * w; i < (k + 1) * w; i++) sum += samples[i] * samples[i]
    out[k] = Math.sqrt(sum / w)
  }
  return out
}

export type BootTrack = { cues: BootCues; envelope: Float32Array; peak: number }

let analysis: Promise<BootTrack | null> | null = null

/**
 * Decode the boot music once and work out its cues. Resolves null if the file
 * is missing or will not decode, and the sequence then runs on DEFAULT_CUES.
 */
export function analyseBootTrack(url = '/audio/boot-music.mp3'): Promise<BootTrack | null> {
  analysis ??= (async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const bytes = await res.arrayBuffer()
      // An OfflineAudioContext decodes without needing a user gesture or an
      // output device.
      const ctx = new OfflineAudioContext(1, 1, 44100)
      const audio = await ctx.decodeAudioData(bytes)
      const envelope = envelopeOf(audio.getChannelData(0), audio.sampleRate)
      let peak = 0
      for (const v of envelope) peak = Math.max(peak, v)
      return { cues: pickCues(envelope), envelope, peak }
    } catch (err) {
      console.warn('[jarvis] boot music could not be analysed, using fixed timing:', err)
      return null
    }
  })()
  return analysis
}

/** 0..1 loudness of the boot music at a moment, for audio-reactive visuals. */
export function levelAt(track: BootTrack | null, ms: number): number {
  if (!track || track.peak <= 0) return 0
  const i = Math.floor(ms / STEP_MS)
  if (i < 0 || i >= track.envelope.length) return 0
  return Math.min(1, track.envelope[i] / track.peak)
}

// -- the hand-off -------------------------------------------------------------

let resolveDone: (() => void) | null = null
let done: Promise<void> = new Promise((r) => (resolveDone = r))

/** Fresh promise for a new power-up. */
export function resetBootDone(): void {
  done = new Promise((r) => (resolveDone = r))
}

/** Boot.tsx calls this when the sequence ends or the user skips it. */
export function markBootDone(): void {
  resolveDone?.()
}

/** App awaits this instead of a fixed timeout. */
export function bootDone(): Promise<void> {
  return done
}
