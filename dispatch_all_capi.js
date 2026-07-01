// Dispara CAPI para TODAS as orders pagas hoje (lookback desde 00:00 UTC),
// independente do limite de 24h do cron. Usado quando user quer reenviar
// tudo de uma só vez pra dashboard Meta refletir.
const axios = require('axios')
const { sendPurchaseToMeta } = require('./lib/metaCapi')

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

async function markSent(id) {
  await axios.patch(`${SUPA}/orders?id=eq.${id}`,
    { meta_capi_sent: true, meta_capi_sent_at: new Date().toISOString() },
    { headers: H, timeout: 10000 })
}

;(async () => {
  const r = await axios.get(
    `${SUPA}/orders?status=eq.paid&meta_capi_sent=eq.false&fbp_pixel_id=not.is.null&paid_at=gte.2026-06-07T00:00:00&order=paid_at.asc&limit=200&select=id,customer_name,customer_email,phone,payment_amount,plan,fbp_pixel_id,fbp,fbc,client_ip,client_user_agent,meta_capi_sent`,
    { headers: H, timeout: 30000 }
  )
  const orders = r.data || []
  console.log(`Total pendentes: ${orders.length}`)
  let ok = 0, fail = 0
  for (const o of orders) {
    try {
      const result = await sendPurchaseToMeta(o)
      if (result?.ok) {
        await markSent(o.id)
        ok++
        console.log(`✅ ${o.id.slice(0,8)} pixel ${o.fbp_pixel_id} ${o.customer_name?.slice(0,30) || ''}`)
      } else {
        fail++
        console.warn(`⚠ ${o.id.slice(0,8)} →`, JSON.stringify(result).slice(0,200))
      }
    } catch (e) {
      fail++
      console.error(`❌ ${o.id.slice(0,8)}`, e.message)
    }
  }
  console.log(`\n═══ ${ok} ok, ${fail} falha ═══`)
})().catch(e => console.error('FATAL', e.message))
