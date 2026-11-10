import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInbox, cleanBody, cleanSubject, decide, inboxConfig, loadState } from '../bridge/inbox.mjs'

const cfg = inboxConfig({
  JARVIS_EMAIL_TO: 'me@example.com',
  JARVIS_SMTP_USER: 'me@example.com',
  JARVIS_SMTP_PASS: 'app-pass',
  JARVIS_EMAIL_CODE: 'falcon42',
})
const since = new Date('2026-11-10T00:00:00Z')
const state = () => ({ since: since.toISOString(), handled: [], sent: ['<jarvis-1@example.com>'] })
const msg = (over = {}) => ({
  messageId: '<m1@example.com>',
  from: 'me@example.com',
  subject: 'Jarvis falcon42: weather?',
  text: 'What is the weather in Tokyo?',
  date: new Date('2026-11-10T12:00:00Z'),
  ...over,
})

test('configured only with credentials, a code word and an owner', () => {
  assert.equal(cfg.enabled, true)
  assert.deepEqual(cfg.allow, ['me@example.com'])
  const off = inboxConfig({ JARVIS_EMAIL_TO: 'me@example.com', JARVIS_SMTP_USER: 'u', JARVIS_SMTP_PASS: 'p' })
  assert.equal(off.enabled, false)
  assert.deepEqual(off.missing, ['JARVIS_EMAIL_CODE'])
})

test('answers the owner with the code word, or a reply to JARVIS', () => {
  assert.equal(decide(msg(), state(), cfg).ok, true)
  const threaded = msg({ subject: 'Re: weather', text: 'and tomorrow?', inReplyTo: '<jarvis-1@example.com>' })
  assert.equal(decide(threaded, state(), cfg).why, 'reply to JARVIS')
})

test('refuses strangers, missing code words, old mail, repeats and its own replies', () => {
  assert.equal(decide(msg({ from: 'attacker@evil.test' }), state(), cfg).why, 'sender not allowed')
  assert.equal(decide(msg({ subject: 'hi', text: 'no code here' }), state(), cfg).ok, false)
  assert.equal(decide(msg({ inReplyTo: '<someone-else@x>', subject: 'Re', text: 'x' }), state(), cfg).ok, false)
  assert.equal(decide(msg({ date: new Date('2026-11-09T12:00:00Z') }), state(), cfg).why, 'older than the switch-on')
  assert.equal(decide(msg({ jarvisReply: true }), state(), cfg).why, 'own reply')
  const s = state()
  s.handled.push('<m1@example.com>')
  assert.equal(decide(msg(), s, cfg).why, 'already handled')
  // The sender check is exact, not a substring.
  assert.equal(decide(msg({ from: 'me@example.com.evil.test' }), state(), cfg).ok, false)
})

test('the body loses quotes, history and the code word', () => {
  const body = cleanBody('Hi FALCON42 what is new?\n\nOn Tue, 10 Nov 2026 JARVIS wrote:\n> old reply\n> more', 'falcon42')
  assert.equal(body, 'Hi what is new?')
  assert.doesNotMatch(body, /falcon42/i)
  assert.doesNotMatch(body, /old reply/)
  assert.equal(cleanSubject('Jarvis falcon42: weather?', 'falcon42'), 'Jarvis: weather?')
})

test('a pass answers once, records it, and never answers again', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jarvis-inbox-')), 'inbox.json')
  const sent = []
  const run = () =>
    checkInbox({
      cfg,
      file,
      fetch: async () => [msg(), msg({ messageId: '<m2@x>', from: 'stranger@x.test' })],
      ask: async (body, subject) => {
        assert.doesNotMatch(`${subject} ${body}`, /falcon42/i, 'the code word never reaches the model')
        return 'It is sunny.\n\nJARVIS'
      },
      send: async (_cfg, to, original, text) => {
        sent.push({ to, subject: original.subject, text })
        return '<jarvis-new@example.com>'
      },
      log: () => {},
      now: () => since,
    })
  const first = await run()
  assert.deepEqual(first, { answered: 1, skipped: 1 })
  assert.equal(sent[0].to, 'me@example.com')
  const second = await run()
  assert.equal(second.answered, 0)
  assert.equal(sent.length, 1)
  assert.ok(loadState(file).sent.includes('<jarvis-new@example.com>'))
})

test('the email agent gets only web reading and memory', async () => {
  const { answer } = await import('../bridge/inbox.mjs')
  const file = join(mkdtempSync(join(tmpdir(), 'jarvis-mem-')), 'memory.json')
  let options
  const reply = await answer('weather?', 'Jarvis: weather', {
    file,
    queryImpl: ({ options: o }) => {
      options = o
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'Sunny.\n\nJARVIS' }
      })()
    },
  })
  assert.equal(reply, 'Sunny.\n\nJARVIS')
  assert.deepEqual(options.tools, ['WebSearch', 'WebFetch'])
  assert.deepEqual(Object.keys(options.mcpServers), ['jarvis_memory'])
  assert.equal(options.strictMcpConfig, true)
  const hook = options.hooks.PreToolUse[0].hooks[0]
  for (const tool of ['Bash', 'Write', 'mcp__jarvis_chrome__chrome_click', 'mcp__gmail__send']) {
    assert.equal((await hook({ tool_name: tool, tool_input: {} })).hookSpecificOutput?.permissionDecision, 'deny', tool)
  }
  assert.deepEqual(await hook({ tool_name: 'mcp__jarvis_memory__remember', tool_input: {} }), {})
  assert.equal((await hook({ tool_name: 'WebFetch', tool_input: { url: 'http://169.254.169.254/' } })).hookSpecificOutput?.permissionDecision, 'deny')
  assert.equal((await options.canUseTool('Bash')).behavior, 'deny')
})
