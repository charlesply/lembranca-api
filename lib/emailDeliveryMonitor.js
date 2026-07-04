// ═══════════════════════════════════════════════════════════════════════════
// Cron rede de segurança pro email de entrega.
// A cada N min varre orders pagas com email + áudios prontos que ainda não
// receberam o email (paid_at NOT NULL, customer_email NOT NULL,
// email_delivery_sent != true). Reenvia tudo que ficou pra trás (webhook caído,
// envio falhou, etc.). Chaveia por paid_at (NÃO status) porque o status às vezes
// fica preso em preview_sent apesar de pago — antes esses nunca eram entregues.
// runOnce({lookbackHours, limit}) permite backfill sob demanda pelo admin.
//
// Gated por EMAIL_DELIVERY_MONITOR_ENABLED=false pra desligar.
// ═══════════════════════════════════════════════════════════════════════════

const { sendDeliveryEmail } = require('./emailDelivery')
const axios = require('axios')

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''
const INTERVAL_MIN = Number(process.env.EMAIL_DELIVERY_INTERVAL_MIN || 10)
const LOOKBACK_HOURS = Number(process.env.EMAIL_DELIVERY_LOOKBACK_HOURS || 48)

function supaHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  }
}

async function findPendingDeliveries(lookbackHours = LOOKBACK_HOURS, limit = 30) {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString()
  // Filtros: PAGO (paid_at — NÃO status; o status às vezes fica preso em
  // preview_sent apesar de pago e a entrega nunca disparava), com email,
  // entrega não feita (false OU null), áudio pronto (original_audio_url).
  const url = `${SUPABASE_URL}/orders?paid_at=not.is.null&paid_at=gte.${since}&customer_email=not.is.null&email_delivery_sent=not.is.true&original_audio_url=not.is.null&order=paid_at.desc&limit=${limit}&select=id,honoree_name,customer_name,customer_email,plan,original_audio_url,full_audio_urls,video_brinde_url,email_delivery_sent`
  try {
    const r = await axios.get(url, { headers: supaHeaders(), timeout: 15000 })
    return r.data || []
  } catch (e) {
    console.error('[emailDeliveryMonitor] erro Supabase:', e.message)
    return []
  }
}

async function runOnce(opts = {}) {
  const lookbackHours = Number(opts.lookbackHours) || LOOKBACK_HOURS
  const limit = Number(opts.limit) || 30
  const pend = await findPendingDeliveries(lookbackHours, limit)
  if (!pend.length) {
    console.log('[emailDeliveryMonitor] ✅ 0 pendentes')
    return { checked: 0, sent: 0 }
  }
  console.log(`[emailDeliveryMonitor] 📬 ${pend.length} email(s) pendente(s)`)
  let sent = 0, failed = 0
  for (const o of pend) {
    try {
      const r = await sendDeliveryEmail(o)
      if (r.ok) { sent++; console.log('[emailDeliveryMonitor] ✅', o.id, '→', o.customer_email) }
      else { failed++; console.warn('[emailDeliveryMonitor] skip', o.id, '→', r.skipped || r.error) }
    } catch (e) {
      failed++
      console.error('[emailDeliveryMonitor] erro', o.id, e.message)
    }
  }
  return { checked: pend.length, sent, failed }
}

function startCron() {
  if (process.env.EMAIL_DELIVERY_MONITOR_ENABLED === 'false') {
    console.log('[emailDeliveryMonitor] desabilitado')
    return
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn('[emailDeliveryMonitor] RESEND_API_KEY não configurada — cron não iniciado')
    return
  }
  console.log(`[emailDeliveryMonitor] ✅ cron ON — varre a cada ${INTERVAL_MIN}min orders pagas sem email (lookback ${LOOKBACK_HOURS}h)`)
  setTimeout(() => { runOnce().catch(e => console.error('[emailDeliveryMonitor]', e.message)) }, 45000)
  setInterval(() => { runOnce().catch(e => console.error('[emailDeliveryMonitor]', e.message)) }, INTERVAL_MIN * 60 * 1000)
}

module.exports = { startCron, runOnce }
