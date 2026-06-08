// Meta Conversions API (CAPI) — envio server-side de eventos pro Facebook/Meta Pixel
// Garante captura 100% mesmo quando cliente fecha aba ou ad-blocker bloqueia o pixel client-side.
// Dedup automático com client-side via event_id compartilhado.

const axios = require('axios')
const crypto = require('crypto')

// Tokens por Pixel — config via env: META_CAPI_TOKENS é JSON
// { "PIXEL_ID_1": "TOKEN_1", "PIXEL_ID_2": "TOKEN_2" }
function getTokens() {
  try {
    return JSON.parse(process.env.META_CAPI_TOKENS || '{}')
  } catch (e) {
    console.error('[metaCapi] META_CAPI_TOKENS inválido:', e.message)
    return {}
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '').trim().toLowerCase()).digest('hex')
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '')
}

// Envia evento Purchase pro Meta via CAPI.
// order: { id, fbp_pixel_id, fbp, fbc, client_ip, client_user_agent,
//          customer_name, customer_email, phone, payment_amount, paid_at }
async function sendPurchaseToMeta(order) {
  const tokens = getTokens()
  const pixelId = order?.fbp_pixel_id
  if (!pixelId) {
    console.log('[metaCapi] order sem fbp_pixel_id — pulando CAPI')
    return { skipped: 'no_pixel' }
  }
  const accessToken = tokens[pixelId]
  if (!accessToken) {
    console.warn('[metaCapi] sem token pro pixel', pixelId, '— pulando CAPI')
    return { skipped: 'no_token' }
  }

  const phoneDigits = digitsOnly(order.phone)
  const firstName = String(order.customer_name || '').trim().split(/\s+/)[0]
  // Email normalizado pro hash (trim + lowercase). Meta exige formato exato.
  const emailRaw = String(order.customer_email || '').trim().toLowerCase()
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)

  // event_id MESMO que o client-side usa pra dedup (purchase_{orderId})
  const eventId = `purchase_${order.id}`

  const userData = {}
  if (phoneDigits) userData.ph = [sha256(phoneDigits)]
  if (emailValid) userData.em = [sha256(emailRaw)]
  if (firstName) userData.fn = [sha256(firstName)]
  if (order.client_ip) userData.client_ip_address = order.client_ip
  if (order.client_user_agent) userData.client_user_agent = order.client_user_agent
  if (order.fbc) userData.fbc = order.fbc
  if (order.fbp) userData.fbp = order.fbp
  if (order.id) userData.external_id = [sha256(order.id)]

  const value = Number(order.payment_amount) || 0

  // event_time: tempo da conversão REAL conforme Meta Best Practices —
  // não o tempo do envio. Meta aceita até 7 dias atrás sem perda de
  // qualidade, 28 dias com degradação gradual. Vital pra:
  //  - Match Quality (alinha com pixel client-side que dispara no paid_at)
  //  - Atribuição correta de campanha (Meta usa event_time pra janela)
  //  - Dedup robusto (mesmo event_id + event_time = mesmo evento)
  // Fallback pra orders raras sem paid_at: now (comportamento legado).
  const NOW = Math.floor(Date.now() / 1000)
  let eventTime = NOW
  if (order.paid_at) {
    const t = Math.floor(new Date(order.paid_at).getTime() / 1000)
    if (Number.isFinite(t) && t > 0 && (NOW - t) < 7 * 24 * 3600) {
      eventTime = t  // dentro da janela de 7d — Meta aceita full quality
    } else if (Number.isFinite(t) && t > 0) {
      eventTime = t  // > 7d — Meta ainda aceita, só degrada Match Quality
      console.warn('[metaCapi] order', order.id, 'paid_at >7d ago — Match Quality reduzido')
    }
  }

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: eventTime,
        event_id: eventId,
        event_source_url: process.env.SITE_URL || 'https://app.lembrancacantada.com',
        action_source: 'website',
        user_data: userData,
        custom_data: {
          currency: 'BRL',
          value,
          content_ids: [order.id],
          content_type: 'product',
          content_name: order.plan || 'musica',
        },
      },
    ],
  }

  try {
    const url = `https://graph.facebook.com/v18.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`
    const r = await axios.post(url, payload, { timeout: 10000 })
    console.log('[metaCapi] ✅ Purchase enviado pixel', pixelId, 'order', order.id, 'received:', r.data?.events_received)
    return { ok: true, eventId, response: r.data }
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message
    console.error('[metaCapi] ❌ erro pixel', pixelId, 'order', order.id, ':', detail)
    return { ok: false, error: detail }
  }
}

module.exports = { sendPurchaseToMeta }
