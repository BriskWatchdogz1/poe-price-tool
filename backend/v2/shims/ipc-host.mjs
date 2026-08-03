// Glue shim: replaces `@/web/background/IPC` (Host) server-side.
// In the browser, Host.proxy(url, init) forwards to `/proxy/<url>`, where the backend
// makes the real request. Server-side, WE ARE the backend → direct fetch.
// getTradeEndpoint() returns a host without a scheme (e.g. "www.pathofexile.com"),
// so we add https:// and a browser UA here (otherwise Cloudflare 403).

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

export const Host = {
  proxy: async (url, init = {}) => {
    const full = /^https?:\/\//.test(url) ? url : `https://${url}`
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...(init.headers || {})
    }
    return await fetch(full, { ...init, headers })
  }
}

export default { Host }
