/**
 * How JARVIS reaches the user when he is not on screen.
 *
 * Four channels, each switched on by its own environment variables and all
 * optional. Destinations come only from the environment, never from the model:
 * whatever a check-in turns up, it can only ever be sent to the user's own
 * phone, inbox or number, so a web page that steers the research cannot steer
 * where the result goes.
 *
 *   push   JARVIS_NTFY_TOPIC                 free, via the ntfy app (ntfy.sh)
 *          JARVIS_NTFY_SERVER                default https://ntfy.sh
 *   email  JARVIS_EMAIL_TO, JARVIS_SMTP_USER, JARVIS_SMTP_PASS
 *          JARVIS_SMTP_HOST (smtp.gmail.com), JARVIS_SMTP_PORT (465)
 *   sms    JARVIS_TWILIO_SID, JARVIS_TWILIO_TOKEN, JARVIS_TWILIO_FROM, JARVIS_SMS_TO
 *   call   the Twilio three above, plus JARVIS_CALL_TO — only for updates the
 *          check-in marks important, because a phone call is an interruption
 */

const env = (k, e) => (e[k] ?? '').trim()

/** Which channels are configured. Pure, so the boot banner and tests can ask. */
export function channels(e = process.env) {
  const twilio = env('JARVIS_TWILIO_SID', e) && env('JARVIS_TWILIO_TOKEN', e) && env('JARVIS_TWILIO_FROM', e)
  return {
    push: Boolean(env('JARVIS_NTFY_TOPIC', e)),
    email: Boolean(env('JARVIS_EMAIL_TO', e) && env('JARVIS_SMTP_USER', e) && env('JARVIS_SMTP_PASS', e)),
    sms: Boolean(twilio && env('JARVIS_SMS_TO', e)),
    call: Boolean(twilio && env('JARVIS_CALL_TO', e)),
  }
}

/**
 * Turn a check-in's updates into the text each channel sends.
 * @param {{ topic: string, headline: string, summary: string, important?: boolean }[]} updates
 */
export function formatDigest(updates) {
  const title = updates.length === 1 ? `JARVIS: ${updates[0].topic}` : `JARVIS: ${updates.length} updates`
  const body = updates.map((u) => `${u.topic}: ${u.headline}\n${u.summary}`).join('\n\n')
  // An SMS segment is 160 characters; keep the text to a few segments.
  const sms = `${title}\n${updates.map((u) => `• ${u.topic}: ${u.headline}`).join('\n')}`.slice(0, 600)
  const important = updates.filter((u) => u.important)
  const spoken = important.length
    ? `Hello, this is JARVIS with an update. ${important.map((u) => `${u.topic}. ${u.headline}. ${u.summary}`).join(' ')} That is all. Goodbye.`
    : ''
  return { title, body, sms, spoken }
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

async function twilio(path, form, e, fetchImpl) {
  const sid = env('JARVIS_TWILIO_SID', e)
  const auth = Buffer.from(`${sid}:${env('JARVIS_TWILIO_TOKEN', e)}`).toString('base64')
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/${path}`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

/**
 * Send one digest on every configured channel. A channel that fails does not
 * stop the others; the result says which went and which did not.
 *
 * @returns {Promise<{ sent: string[], failed: { channel: string, error: string }[] }>}
 */
export async function sendDigest(updates, { env: e = process.env, fetchImpl = fetch, mailer } = {}) {
  const on = channels(e)
  const msg = formatDigest(updates)
  const sent = []
  const failed = []
  const attempt = async (channel, fn) => {
    try {
      await fn()
      sent.push(channel)
    } catch (err) {
      failed.push({ channel, error: String(err?.message ?? err) })
    }
  }

  if (on.push) {
    await attempt('push', async () => {
      const server = (env('JARVIS_NTFY_SERVER', e) || 'https://ntfy.sh').replace(/\/+$/, '')
      const res = await fetchImpl(`${server}/${encodeURIComponent(env('JARVIS_NTFY_TOPIC', e))}`, {
        method: 'POST',
        // ntfy reads the title from a header, and headers must be plain ASCII.
        headers: { title: msg.title.replace(/[^\x20-\x7e]/g, ''), tags: 'robot' },
        body: msg.body,
      })
      if (!res.ok) throw new Error(`ntfy ${res.status}`)
    })
  }

  if (on.email) {
    await attempt('email', async () => {
      const send =
        mailer ??
        (await (async () => {
          const { createTransport } = await import('nodemailer')
          const port = Number(env('JARVIS_SMTP_PORT', e) || 465)
          const transport = createTransport({
            host: env('JARVIS_SMTP_HOST', e) || 'smtp.gmail.com',
            port,
            secure: port === 465,
            auth: { user: env('JARVIS_SMTP_USER', e), pass: env('JARVIS_SMTP_PASS', e) },
          })
          return (mail) => transport.sendMail(mail)
        })())
      await send({
        from: `JARVIS <${env('JARVIS_SMTP_USER', e)}>`,
        to: env('JARVIS_EMAIL_TO', e),
        subject: msg.title,
        text: msg.body,
      })
    })
  }

  if (on.sms) {
    await attempt('sms', () =>
      twilio('Messages.json', { To: env('JARVIS_SMS_TO', e), From: env('JARVIS_TWILIO_FROM', e), Body: msg.sms }, e, fetchImpl),
    )
  }

  if (on.call && msg.spoken) {
    await attempt('call', () =>
      twilio(
        'Calls.json',
        {
          To: env('JARVIS_CALL_TO', e),
          From: env('JARVIS_TWILIO_FROM', e),
          Twiml: `<Response><Say voice="Polly.Brian">${xml(msg.spoken)}</Say></Response>`,
        },
        e,
        fetchImpl,
      ),
    )
  }

  return { sent, failed }
}
