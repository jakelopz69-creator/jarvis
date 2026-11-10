import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'tsx/esm/api'

register()
const { DEFAULT_CUES, STEP_MS, envelopeOf, onsets, pickCues } = await import('../src/lib/bootCues.ts')

/** A loudness envelope: a quiet bed with sudden hits at the given seconds. */
function track(seconds, hits) {
  const env = Array.from({ length: Math.round((seconds * 1000) / STEP_MS) }, () => 0.05)
  for (const [at, loud] of hits) {
    const i = Math.round((at * 1000) / STEP_MS)
    for (let k = i; k < Math.min(env.length, i + 12); k++) env[k] = loud * (1 - (k - i) / 14)
  }
  return env
}

test('each stage lands on the hit in its window, in order', () => {
  // Shaped like the shipped Impact Prelude: build, rise ~4.9s, big hit 6.55s, hit 10.1s.
  const cues = pickCues(track(17, [[4.9, 0.5], [6.55, 1], [7.7, 0.45], [10.1, 0.8]]))
  assert.equal(cues.rings, 4900)
  assert.equal(cues.suit, 6550)
  assert.equal(cues.reactor, 10100)
  assert.ok(cues.end > cues.reactor)
})

test('a track with no hits keeps the default pacing', () => {
  const cues = pickCues(track(17, []))
  assert.equal(cues.rings, DEFAULT_CUES.rings)
  assert.ok(cues.suit > cues.rings && cues.reactor > cues.suit && cues.end > cues.reactor)
})

test('silence does not divide by zero', () => {
  assert.ok(onsets([0, 0, 0]).every((v) => v === 0))
})

test('the envelope is RMS per step', () => {
  const rate = 1000
  const s = new Float32Array(rate).fill(0.5)
  const env = envelopeOf(s, rate, 100)
  assert.equal(env.length, 10)
  assert.ok(Math.abs(env[0] - 0.5) < 1e-6)
})
