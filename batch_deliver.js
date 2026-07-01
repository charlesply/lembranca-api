// Busca multiplos pedidos por telefone OU prefix de id, retorna o resumo
// p/ download.
const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const targets = [
  { label: '9389', tails: ['99159389', '9159389'], prefix: '48471d80' }, // 84 9915-9389
  { label: '6494', tails: ['83056494'], prefix: null },                  // 31 8305-6494
  { label: '3283', tails: ['87033283'], prefix: null },                  // 83 8703-3283
]

async function searchOne(t) {
  // 1) busca por id prefix (mais confiavel)
  if (t.prefix) {
    const r = await axios.get(
      SUPA + `/orders?id=gte.${t.prefix}-0000-0000-0000-000000000000&id=lte.${t.prefix}-ffff-ffff-ffff-ffffffffffff&select=*&order=created_at.desc`,
      { headers: H }
    )
    if (r.data.length) return r.data
  }
  // 2) busca por phone tail
  for (const tail of t.tails) {
    const r = await axios.get(
      SUPA + `/orders?phone=like.*${tail}&select=*&order=created_at.desc&limit=10`,
      { headers: H }
    )
    if (r.data.length) return r.data
  }
  return []
}

;(async () => {
  for (const t of targets) {
    const orders = await searchOne(t)
    console.log('═══ Contato', t.label, '═══')
    if (!orders.length) { console.log('  ❌ nada encontrado\n'); continue }
    // Pega o mais relevante: paid primeiro, senao o mais recente
    const paid = orders.find(o => o.status === 'paid')
    const o = paid || orders[0]
    console.log('  order   :', o.id)
    console.log('  customer:', o.customer_name, '| phone:', o.phone)
    console.log('  honoree :', o.honoree_name)
    console.log('  plan    :', o.plan, '| amount:', o.payment_amount)
    console.log('  status  :', o.status, '| paid_at:', o.paid_at)
    const arr = Array.isArray(o.full_audio_urls) ? o.full_audio_urls : []
    arr.forEach((u, i) => console.log(`  v${i+1}      :`, u))
    if (!arr.length && o.original_audio_url) console.log('  original:', o.original_audio_url)
    if (o.video_brinde_url) console.log('  video   :', o.video_brinde_url)
    if (orders.length > 1) console.log('  (+', orders.length - 1, 'tentativas a mais)')
    console.log()
  }
})().catch(e => console.error('ERR', e.message))
