/**
 * Neural speech, entirely in the browser.
 *
 * `speechSynthesis` is limited to whatever voices the operating system ships,
 * and on macOS the British male option is Daniel — a compact concatenative
 * voice from over a decade ago. It is the honest ceiling of the built-in API
 * and it sounds like a satnav.
 *
 * Kokoro is an 82M-parameter TTS model that runs on WebGPU via ONNX. No cloud,
 * no API key, nothing leaves the machine — but it sounds like a person. It
 * carries four British male voices, which is what this project actually wants.
 *
 * The cost is a one-time ~86MB model download, cached by the browser
 * afterwards. It's fetched during the boot sequence so the first "Hey Jarvis"
 * isn't waiting on it, and anything that goes wrong falls back to Daniel.
 */

import { KOKORO_VOICE } from '../config'

type Kokoro = {
  generate: (
    text: string,
    opts: { voice: string; speed?: number },
  ) => Promise<{ toBlob: () => Blob }>
}

let model: Kokoro | null = null
let loading: Promise<Kokoro | null> | null = null
let failed = false

/** 0..1 while the model downloads, for the boot readout. */
let progress = 0
export const loadProgress = () => progress
export const isReady = () => model !== null
export const isUnavailable = () => failed

/** Exposed for diagnosis — the console warning alone is easy to miss. */
export let lastError = ''

/** Where the model ended up running: 'webgpu', 'wasm', or '' before it loads. */
export let device: '' | 'webgpu' | 'wasm' = ''

/**
 * British male voices, in the order they suit the character. George is the
 * closest to a measured RP baritone; Fable is warmer, Lewis lower, Daniel
 * brighter.
 */
export const VOICES = ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const

/**
 * A voice id the model doesn't carry throws inside generate(), once per
 * sentence, for the life of the page — and a typo in an env var is the likeliest
 * way to get there. Check it once at module load and fall back audibly in the
 * console instead.
 */
function resolveVoice(): string {
  if ((VOICES as readonly string[]).includes(KOKORO_VOICE)) return KOKORO_VOICE
  console.warn(
    `[jarvis] VITE_KOKORO_VOICE="${KOKORO_VOICE}" is not one of ${VOICES.join(', ')} — using ${VOICES[0]}.`,
  )
  return VOICES[0]
}

const voice = resolveVoice()

/**
 * Generation failures latch after this many in a row. One is worth retrying —
 * a WebGPU device can be lost and recovered — but a run of them means the
 * engine is not going to work on this machine, and it is better to drop to the
 * system voice for good than to alternate between the two mid-conversation.
 */
const MAX_FAILURES = 3
let failures = 0

/**
 * Which device to try. `auto` prefers the GPU and falls back to the CPU;
 * VITE_KOKORO_DEVICE=cpu skips the GPU entirely for a machine whose WebGPU
 * loads but misbehaves, and =gpu refuses the fallback (for testing).
 */
const DEVICE_PREF = String(import.meta.env.VITE_KOKORO_DEVICE ?? 'auto').toLowerCase()

/**
 * Precision per device. q8 is about 86MB and right for the CPU, but on WebGPU
 * it generates broken audio — silence or noise — and kokoro-js says to use
 * fp32 there. That costs a one-time 330MB download, cached afterwards.
 */
const DTYPE = { webgpu: 'fp32', wasm: 'q8' } as const

/** Set once the GPU has produced bad audio, so every later load goes to the CPU. */
let gpuBroken = false

export async function load(): Promise<Kokoro | null> {
  if (model) return model
  if (failed) return null
  if (loading) return loading

  loading = (async () => {
    try {
      // Point the ONNX runtime at this origin's copy of its loader and WASM
      // binary (see ortAssets in vite.config.ts). Left to transformers.js it
      // fetches them from a CDN, which the page's CSP refuses to run.
      const { env } = await import('@huggingface/transformers')
      const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; proxy?: boolean } }
      if (onnx.wasm) onnx.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`
      const { KokoroTTS } = await import('kokoro-js')
      const open = (target: 'webgpu' | 'wasm') =>
        KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
          dtype: DTYPE[target],
          device: target,
          // The callback is a union across several event shapes; only the
          // download-progress one carries a percentage.
          progress_callback: (p: unknown) => {
            const pct = (p as { progress?: number })?.progress
            if (typeof pct === 'number') progress = pct / 100
          },
        })
      // WebGPU keeps generation well ahead of playback, but plenty of
      // machines and drivers do not expose it to Chrome, or expose one that
      // misbehaves. The CPU runs the same voice through WebAssembly: slower to
      // start each sentence, still the same voice.
      const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
      const tryGpu = hasGpu && !gpuBroken && DEVICE_PREF !== 'cpu'
      let tts
      if (tryGpu) {
        try {
          tts = await open('webgpu')
          device = 'webgpu'
        } catch (err) {
          if (DEVICE_PREF === 'gpu') throw err
          console.warn('[jarvis] kokoro on WebGPU failed, trying the CPU instead:', err)
        }
      }
      if (!tts) {
        if (DEVICE_PREF === 'gpu') throw new Error('WebGPU is not available in this browser')
        // On the CPU the model runs in a worker. Run on the page itself it
        // blocks the main thread for the whole sentence — measured at twenty
        // seconds with no timer, click or microphone event getting through,
        // which is a frozen assistant. (WebGPU cannot use the proxy.)
        if (onnx.wasm) onnx.wasm.proxy = true
        tts = await open('wasm')
        device = 'wasm'
      }
      console.info(`[jarvis] kokoro voice ready on ${device} (${device ? DTYPE[device] : ''})`)
      progress = 1
      model = tts as unknown as Kokoro
      return model
    } catch (err) {
      console.warn('[jarvis] kokoro unavailable, using the system voice:', err)
      lastError = String((err as Error)?.message ?? err)
      failed = true
      return null
    } finally {
      loading = null
    }
  })()

  return loading
}

/**
 * True when generated samples are unusable: any NaN or infinity, or nothing
 * louder than a whisper. A misbehaving GPU returns exactly this, and playing
 * it is indistinguishable from the voice being off.
 */
export function isBadAudio(samples: ArrayLike<number> | undefined): boolean {
  if (!samples || samples.length === 0) return true
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    if (!Number.isFinite(v)) return true
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  return peak < 1e-3
}

/**
 * How long one sentence may take to generate before it is spoken by the
 * system voice instead. On a CPU without threads (the browser only allows
 * them on cross-origin-isolated pages) Kokoro can take three seconds for
 * "Yes, sir?" and eighteen for a long sentence — measured — and an assistant
 * that sits silent that long reads as frozen.
 */
export const budgetMs = (text: string) => 4000 + 45 * text.length

/** Sentences in a row that blew the budget before the voice is retired. */
const MAX_SLOW = 2
let slow = 0
/** Set when Kokoro was retired for being too slow on this machine. */
export let tooSlow = false

const TIMEOUT = Symbol('timeout')

/**
 * Synthesise one sentence. Returns null — and the caller speaks it with the
 * system voice — whenever Kokoro cannot deliver promptly: still downloading,
 * failed, or slower than budgetMs on this machine.
 */
export async function speak(text: string): Promise<string | null> {
  if (failed) return null
  // Never wait on a download: the first-time model is 86-330MB, and waiting
  // on it is minutes of silence. Speak with the system voice until it is in.
  if (!model) {
    void load()
    return null
  }
  const tts = model
  try {
    const generating = tts.generate(text, {
      voice,
      // Slightly under natural pace — the character is never hurried, and the
      // steadiness is most of the characterisation.
      speed: 0.95,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const audio = await Promise.race([
      generating,
      new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), budgetMs(text)))),
    ]).finally(() => clearTimeout(timer))
    if (audio === TIMEOUT) {
      // The run cannot be cancelled; let it finish unobserved.
      generating.catch(() => {})
      slow++
      lastError = `slower than ${Math.round(budgetMs(text) / 1000)}s for one sentence`
      if (slow >= MAX_SLOW) {
        tooSlow = true
        failed = true
        console.warn('[jarvis] kokoro is too slow on this machine — the system voice from here on.')
      }
      return null
    }
    slow = 0
    const samples = (audio as unknown as { audio?: Float32Array }).audio
    if (device === 'webgpu' && DEVICE_PREF !== 'gpu' && isBadAudio(samples)) {
      // The GPU path loaded but speaks silence. Move to the CPU for good and
      // say this sentence again there, rather than leave him mute.
      console.warn('[jarvis] kokoro produced silent audio on WebGPU — switching to the CPU')
      gpuBroken = true
      model = null
      device = ''
      void load()
      return null
    }
    failures = 0
    return URL.createObjectURL(audio.toBlob())
  } catch (err) {
    // Surfaced rather than swallowed: a silent null here just looks like the
    // voice quietly reverting to the system one with no explanation.
    console.error('[jarvis] kokoro generation failed:', err)
    lastError = String((err as Error)?.message ?? err)
    failures++
    if (failures >= MAX_FAILURES) {
      // Nothing else sets this on the generation path, so without it tts.ts
      // keeps routing every sentence here and every sentence keeps throwing.
      failed = true
      console.warn(
        `[jarvis] kokoro failed ${failures} times running — the system voice from here on.`,
      )
    }
    return null
  }
}

/** Voice ids this build of the model actually carries. */
export async function availableVoices(): Promise<string[]> {
  const tts = (await load()) as unknown as { voices?: Record<string, unknown> } | null
  return tts?.voices ? Object.keys(tts.voices) : []
}
