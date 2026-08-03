// Glue shim: replaces `@/web/Config` server-side.
// APT's Config.ts pulls in the entire widget/Vue ecosystem (widget registry, host, …).
// Our import graph only needs two things from it, though:
//   - AppConfig('price-check').apiLatencySeconds  (in trade/common.ts, rate limit desync)
//   - poeWebApi() as getTradeEndpoint()          (in trade/common.ts)
// Language/league come from the engine config; fixed, sensible defaults here.

const state = {
  language: 'en',
  useIntlSite: false,
  apiLatencySeconds: 2
}

export function setConfig (patch) {
  Object.assign(state, patch)
}

export function AppConfig (type) {
  if (type === 'price-check') {
    return { apiLatencySeconds: state.apiLatencySeconds }
  }
  // AppConfig() without an argument: global config part (language/useIntlSite for poeWebApi)
  return { language: state.language, useIntlSite: state.useIntlSite }
}

export function poeWebApi () {
  const { language, useIntlSite } = AppConfig()
  if (useIntlSite) return 'www.pathofexile.com'
  switch (language) {
    case 'en': return 'www.pathofexile.com'
    case 'ru': return 'ru.pathofexile.com'
    case 'cmn-Hant': return 'pathofexile.tw'
    case 'ko': return 'poe.kakaogames.com'
    default: return 'www.pathofexile.com'
  }
}

export default { AppConfig, poeWebApi, setConfig }
