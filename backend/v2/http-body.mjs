// Bounded request bodies for the hotkey daemon's routes (`/daemon/*`,
// frontend/PROTOCOL.md). readBody in server.mjs has no limit, and a route that
// anyone on the LAN can reach without a login should not buffer an unbounded
// body. POST /item keeps readBody, untouched.

export class BodyTooLarge extends Error {
  constructor (max) {
    super(`body larger than ${max} bytes`)
    this.name = 'BodyTooLarge'
    this.max = max
  }
}

// Resolves the body as utf8. Past maxBytes it stops reading (req.pause()) and
// rejects with BodyTooLarge; the caller writes the 413 and then destroys the
// request, so the rest is never buffered.
export function readBodyLimited (req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', c => {
      if (done) return
      size += c.length
      if (size > maxBytes) {
        done = true
        try { req.pause() } catch { /* already gone */ }
        reject(new BodyTooLarge(maxBytes))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')) } })
    req.on('error', e => { if (!done) { done = true; reject(e) } })
  })
}

// JSON.parse with a one-word reason instead of a throw; only plain objects
// pass (an array, a number or null is not a request body these routes read).
// -> { ok: true, value } | { ok: false, error: 'bad json' | 'not an object' }
export function parseJsonBody (text) {
  let value
  try { value = JSON.parse(text) } catch { return { ok: false, error: 'bad json' } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'not an object' }
  return { ok: true, value }
}
