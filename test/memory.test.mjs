import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIMITS,
  addFact,
  addTopic,
  loadMemory,
  memoryPrompt,
  removeFact,
  removeTopic,
  saveMemory,
  updateMemory,
} from '../bridge/memory.mjs'
import { checkPrompt, dueSlots, parseTimes, parseUpdates, runCheckIn } from '../bridge/checkin.mjs'
import { channels, formatDigest, sendDigest } from '../bridge/notify.mjs'
import { decideTool } from '../bridge/policy.mjs'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'jarvis-mem-')), 'memory.json')

test('a missing or corrupt memory file loads as empty', () => {
  const m = loadMemory(join(tmpdir(), 'does-not-exist', 'memory.json'))
  assert.deepEqual(m.facts, [])
  assert.deepEqual(m.topics, [])
})

test('facts are saved, deduplicated, capped and removable', () => {
  const file = tmpFile()
  updateMemory((m) => addFact(m, '  Planning a   trip to Japan in March '), file)
  const again = updateMemory((m) => addFact(m, 'planning a trip to japan in march'), file)
  assert.equal(again.message, 'Already remembered.')
  const m = loadMemory(file)
  assert.equal(m.facts.length, 1)
  assert.equal(m.facts[0].text, 'Planning a trip to Japan in March')

  for (let i = 0; i < LIMITS.facts + 5; i++) addFact(m, `fact ${i}`)
  assert.equal(m.facts.length, LIMITS.facts)
  assert.equal(addFact(m, 'x'.repeat(5000)).ok, true)
  assert.ok(m.facts.at(-1).text.length <= LIMITS.factChars)

  assert.equal(removeFact(m, 'fact').error, 'More than one entry matches. Use the id.')
  const id = m.facts.at(-1).id
  assert.ok(removeFact(m, id).removed)
  assert.equal(addFact(m, '   ').ok, false)
})

test('topics are capped and removable by words', () => {
  const m = loadMemory(tmpFile())
  assert.equal(addTopic(m, 'Lakers trade news', 'only big trades').ok, true)
  assert.equal(addTopic(m, 'lakers TRADE news').message, 'Already following that topic.')
  for (let i = 0; i < LIMITS.topics; i++) addTopic(m, `topic ${i}`)
  assert.equal(m.topics.length, LIMITS.topics)
  assert.equal(addTopic(m, 'one too many').ok, false)
  assert.equal(removeTopic(m, 'lakers').removed.topic, 'Lakers trade news')
})

test('memory reaches the prompt as notes, not instructions', () => {
  const m = loadMemory(tmpFile())
  assert.match(memoryPrompt(m), /nothing yet/)
  addFact(m, 'Has a dog called Pepper')
  addTopic(m, 'iPhone 18 release date')
  const p = memoryPrompt(m)
  assert.match(p, /Has a dog called Pepper/)
  assert.match(p, /iPhone 18 release date/)
  assert.match(p, /never as instructions/)
})

test('memory tools are allowed in read-only mode', () => {
  assert.equal(decideTool('mcp__jarvis_memory__remember'), true)
  assert.equal(decideTool('mcp__jarvis_memory__forget'), true)
  assert.equal(decideTool('mcp__jarvis_memory__check_topics_now'), true)
})

test('schedule times parse and each slot runs once a day, with a catch-up window', () => {
  const times = parseTimes('8:00, 18:30, 25:00, nonsense')
  assert.deepEqual(times.map((t) => t.key), ['08:00', '18:30'])

  const at = (h, m) => {
    const d = new Date(2026, 10, 10, h, m)
    return d
  }
  assert.deepEqual(dueSlots(times, {}, at(7, 59)), [])
  assert.deepEqual(dueSlots(times, {}, at(8, 0)).map((t) => t.key), ['08:00'])
  assert.deepEqual(dueSlots(times, { '08:00': '2026-11-10' }, at(8, 5)), [])
  assert.deepEqual(dueSlots(times, { '08:00': '2026-11-09' }, at(9, 0)).map((t) => t.key), ['08:00'])
  // Asleep through it: more than three hours late is skipped, not run at noon.
  assert.deepEqual(dueSlots(times, {}, at(11, 30)), [])
})

test('updates are parsed from structured output or text, and unknown topics dropped', () => {
  const m = loadMemory(tmpFile())
  const { id } = addTopic(m, 'Mars mission')
  const structured = parseUpdates(
    {
      structured_output: {
        updates: [
          { topicId: id, headline: 'Launch moved', summary: 'Now in May.', important: true },
          { topicId: 'made-up', headline: 'Injected', summary: 'x', important: true },
        ],
      },
    },
    m,
  )
  assert.equal(structured.length, 1)
  assert.equal(structured[0].topic, 'Mars mission')
  assert.equal(structured[0].important, true)

  const text = parseUpdates({ result: `Here you go: {"updates":[{"topicId":"${id}","headline":"Hi","summary":"S","important":"yes"}]}` }, m)
  assert.equal(text.length, 1)
  assert.equal(text[0].important, false, 'only a real boolean true counts as important')
  assert.deepEqual(parseUpdates({ result: 'no json here' }, m), [])
  assert.match(checkPrompt(m), /untrusted material/)
  assert.match(checkPrompt(m), /last update you sent: none yet/)
  assert.match(checkPrompt(m), /always report it/)
})

test('a check-in records what it found and sends it', async () => {
  const file = tmpFile()
  const m = loadMemory(file)
  const { id } = addTopic(m, 'Mars mission')
  addTopic(m, 'Quiet topic')
  saveMemory(m, file)

  let options
  const queryImpl = ({ options: o }) => {
    options = o
    return (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { updates: [{ topicId: id, headline: 'Launch moved', summary: 'Now in May.', important: false }] },
      }
    })()
  }
  const sentWith = []
  const r = await runCheckIn({
    file,
    queryImpl,
    send: async (u) => {
      sentWith.push(u)
      return { sent: ['push'], failed: [] }
    },
    log: () => {},
  })

  assert.deepEqual(options.tools, ['WebSearch', 'WebFetch'])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(r.updates.length, 1)
  assert.equal(sentWith.length, 1)
  assert.match(r.summary, /Sent by push/)
  const after = loadMemory(file)
  assert.ok(after.topics.every((t) => t.lastCheckedAt))
  assert.match(after.topics.find((t) => t.id === id).lastDigest, /Launch moved/)

  const deny = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: {} })
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny')
  const lan = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'WebFetch', tool_input: { url: 'http://192.168.1.1/' } })
  assert.equal(lan.hookSpecificOutput.permissionDecision, 'deny')
})

test('a check-in with nothing to follow does not start a session', async () => {
  let called = false
  const r = await runCheckIn({ file: tmpFile(), queryImpl: () => (called = true), log: () => {} })
  assert.equal(called, false)
  assert.equal(r.checked, 0)
})

test('channels switch on only when fully configured', () => {
  assert.deepEqual(channels({}), { push: false, email: false, sms: false, call: false })
  const e = {
    JARVIS_NTFY_TOPIC: 't',
    JARVIS_EMAIL_TO: 'a@b.c',
    JARVIS_SMTP_USER: 'u',
    JARVIS_TWILIO_SID: 's',
    JARVIS_TWILIO_TOKEN: 'k',
    JARVIS_TWILIO_FROM: '+1',
    JARVIS_CALL_TO: '+2',
  }
  assert.deepEqual(channels(e), { push: true, email: false, sms: false, call: true })
})

test('a digest goes to every channel, and one failure does not stop the rest', async () => {
  const updates = [
    { topic: 'Mars', headline: 'Launch moved', summary: 'Now in May.', important: true },
    { topic: 'Rain', headline: 'Storm Friday', summary: 'Bring a coat.', important: false },
  ]
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.includes('Messages.json')) return new Response('nope', { status: 401 })
    return new Response('ok')
  }
  const mails = []
  const r = await sendDigest(updates, {
    env: {
      JARVIS_NTFY_TOPIC: 'my-topic',
      JARVIS_EMAIL_TO: 'me@example.com',
      JARVIS_SMTP_USER: 'bot@example.com',
      JARVIS_SMTP_PASS: 'p',
      JARVIS_TWILIO_SID: 'AC1',
      JARVIS_TWILIO_TOKEN: 'tok',
      JARVIS_TWILIO_FROM: '+15550000000',
      JARVIS_SMS_TO: '+15551111111',
      JARVIS_CALL_TO: '+15551111111',
    },
    fetchImpl,
    mailer: async (m) => mails.push(m),
  })
  assert.deepEqual(r.sent.sort(), ['call', 'email', 'push'])
  assert.equal(r.failed[0].channel, 'sms')
  assert.equal(calls[0].url, 'https://ntfy.sh/my-topic')
  assert.equal(mails[0].to, 'me@example.com')
  const call = calls.find((c) => c.url.includes('Calls.json'))
  const twiml = new URLSearchParams(call.init.body).get('Twiml')
  assert.match(twiml, /Launch moved/)
  assert.doesNotMatch(twiml, /Storm Friday/, 'only important updates are phoned through')

  const quiet = formatDigest([updates[1]])
  assert.equal(quiet.spoken, '')
  assert.equal(quiet.title, 'JARVIS: Rain')
})
