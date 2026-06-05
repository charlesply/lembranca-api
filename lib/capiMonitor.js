// Cron CAPI Monitor — rede de segurança pra Meta CAPI.
// A cada N minutos varre orders pagas das últimas 24h que ainda não
// tiveram Purchase enviado e dispara o CAPI retroativamente.
//
// Por que existe:
//   - Webhook AbacatePay pode falhar (rede, restart do backend, etc).
//   - Cliente pode pagar exatamente durante deploy/restart.
//   - Token CAPI pode estar mal-configurado e queremos garantir reenvio
//     assim que voltar.
//
// Gated por CAPI_MONITOR_ENABLED=true (default ON pra prod).

const { sendPurchaseToMeta } = require('./metaCapi')
const axios = require('axios')

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''
const INTERVAL_MIN = Number(process.env.CAPI_MONITOR_INTERVAL_MIN || 15)
const LOOKBACK_HOURS = Number(process.env.CAPI_MONITOR_LOOKBACK_HOURS || 24)

function supaHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

async function findUnsentPaidOrders() {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString()
  const url = `${SUPABASE_URL}/orders?status=eq.paid&meta_capi_sent=eq.false&fbp_pixel_id=not.is.null&paid_at=gte.${since}&order=paid_at.desc&limit=50`
  try {
    const r = await axios.get(url, { headers: supaHeaders(), timeout: 15000 })
    return r.data || []
  } catch (e) {
    console.error('[capiMonitor] erro Supabase:', e.message)
    return []
  }
}

async function markSent(orderId) {
  try {
    await axios.patch(
      `${SUPABASE_URL}/orders?id=eq.${orderId}`,
      { meta_capi_sent: true, meta_capi_sent_at: new Date().toISOString() },
      { headers: supaHeaders(), timeout: 10000 }
    )
  } catch (e) {
    console.error('[capiMonitor] erro PATCH:', orderId, e.message)
  }
}

async function runOnce() {
  const orders = await findUnsentPaidOrders()
  if (!orders.length) {
    console.log('[capiMonitor] ✅ tudo em dia, 0 orders pendentes')
    return { checked: 0, sent: 0 }
  }
  console.log(`[capiMonitor] 🔍 ${orders.length} orders pagas sem CAPI — tentando enviar`)
  let sent = 0
  let failed = 0
  for (const o of orders) {
    try {
      const result = await sendPurchaseToMeta(o)
      if (result?.ok) {
        await markSent(o.id)
        sent++
        console.log('[capiMonitor] ✅ recuperado', o.id, 'pixel', o.fbp_pixel_id)
      } else {
        failed++
        console.warn('[capiMonitor] ⚠ não enviou', o.id, '→', JSON.stringify(result))
      }
    } catch (e) {
      failed++
      console.error('[capiMonitor] erro envio', o.id, e.message)
    }
  }
  console.log(`[capiMonitor] resumo: ${sent} reenviadas, ${failed} falharam de ${orders.length} pendentes`)
  return { checked: orders.length, sent, failed }
}

function startCron() {
  if (process.env.CAPI_MONITOR_ENABLED === 'false') {
    console.log('[capiMonitor] desabilitado (CAPI_MONITOR_ENABLED=false)')
    return
  }
  console.log(`[capiMonitor] ✅ cron ON — varre a cada ${INTERVAL_MIN}min orders pagas das últimas ${LOOKBACK_HOURS}h sem CAPI`)
  // Roda 30s após boot pra estabilizar
  setTimeout(() => { runOnce().catch(e => console.error('[capiMonitor]', e.message)) }, 30000)
  setInterval(() => { runOnce().catch(e => console.error('[capiMonitor]', e.message)) }, INTERVAL_MIN * 60 * 1000)
}

module.exports = { startCron, runOnce }
