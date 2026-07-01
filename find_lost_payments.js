// Lê os logs do container, extrai todos os webhooks AbacatePay PAID,
// e marca quais NÃO tiveram "order XXX PAID" depois (bug do parse).
const { execSync } = require('child_process')
const axios = require('axios')

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

;(async () => {
  // Lê últimas 48h de logs (esse script roda DENTRO do container, daí o /proc)
  // Estratégia: ler stdin que vamos passar via shell
  const raw = require('fs').readFileSync('/tmp/all_logs.txt', 'utf-8')
  const lines = raw.split('\n')

  const webhooks = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('[webhook abacatepay] RAW:')) continue
    const json = lines[i].slice(lines[i].indexOf('RAW:') + 5).trim()
    let body
    try { body = JSON.parse(json) } catch { continue }
    const t = body?.data?.transparent
    if (!t || t.status !== 'PAID') continue
    const orderId = t.metadata?.order_id
    const paymentId = t.id
    const amount = t.amount
    // Olha as 5 linhas seguintes — tem "order XXX PAID"?
    const followups = lines.slice(i + 1, i + 10).join('\n')
    const wasMarked = followups.includes(`order ${orderId} PAID`) || followups.includes(`already`)
    webhooks.push({ orderId, paymentId, amount, wasMarked, ts: lines[i].slice(0, 30) })
  }

  console.log(`Total webhooks PAID encontrados: ${webhooks.length}`)
  const lost = webhooks.filter(w => !w.wasMarked && w.orderId)
  console.log(`Lost (não marcados como paid no DB): ${lost.length}\n`)

  if (!lost.length) {
    console.log('✅ Nenhum pagamento perdido')
    return
  }

  // Pra cada lost: checa estado atual no DB
  for (const w of lost) {
    try {
      const r = await axios.get(`${SUPA}/orders?id=eq.${w.orderId}&select=id,status,paid_at,phone,customer_name,honoree_name,plan,payment_amount,abacate_charge_id`, { headers: H })
      const o = r.data[0]
      if (!o) { console.log('  -', w.orderId, 'NAO_EXISTE'); continue }
      const tag = o.status === 'paid' ? '✅ JÁ_PAID' : '🚨 PERDIDO'
      console.log(`${tag} ${o.id.slice(0,8)} | ${o.customer_name} → ${o.honoree_name} | R$${o.amount || w.amount/100} | DB.status=${o.status} | webhook_ts=${w.ts}`)
      console.log(`     paymentId webhook: ${w.paymentId}`)
      console.log(`     charge_id DB:      ${o.abacate_charge_id}`)
    } catch (e) {
      console.log('  -', w.orderId, 'ERR', e.message)
    }
  }
})().catch(e => console.error('FATAL:', e.message))
