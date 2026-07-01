// Busca pedidos que provavelmente sao as 2 disputas abertas no AbacatePay:
//   R$ 29,90 (criada 05/06 14:46)
//   R$ 19,90 (criada 05/06 12:08)
const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

;(async () => {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()
  const r = await axios.get(
    SUPA + '/orders?status=eq.paid&paid_at=gte.' + since + '&select=id,honoree_name,customer_name,amount_cents,payment_amount,paid_at,plan,abacate_charge_id&order=paid_at.desc&limit=300',
    { headers: H }
  )
  console.log('total pagas ultimos 14d:', r.data.length)

  const fmt = (o) => [
    o.id.slice(0, 8),
    o.paid_at,
    (o.honoree_name || o.customer_name || '?').slice(0, 25),
    o.plan || '-',
    'amount_cents=' + o.amount_cents,
    'payment_amount=' + o.payment_amount,
    'charge=' + (o.abacate_charge_id || '-'),
  ].join(' | ')

  const c29 = r.data.filter(o => o.amount_cents === 2990 || Number(o.payment_amount) === 29.9 || Number(o.payment_amount) === 2990)
  const c19 = r.data.filter(o => o.amount_cents === 1990 || Number(o.payment_amount) === 19.9 || Number(o.payment_amount) === 1990)

  console.log('\n=== candidatos R$ 29,90 (' + c29.length + ') ===')
  c29.forEach(o => console.log(fmt(o)))
  console.log('\n=== candidatos R$ 19,90 (' + c19.length + ') ===')
  c19.forEach(o => console.log(fmt(o)))
})().catch(e => { console.error('ERR', e.message, JSON.stringify(e.response?.data)); process.exit(1) })
