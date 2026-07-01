// Busca pedidos pagos pelos telefones fornecidos.
// Aceita variacoes (com/sem 9, com/sem 55, com/sem mascara).
const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

// numero base (DDD + ultimos 8): vamos buscar com LIKE pra pegar com/sem 9
const targets = [
  { raw: '+55 42 9973-4849', ddd: '42', tail: '99734849' },
  { raw: '+55 98 8345-9358', ddd: '98', tail: '83459358' },
  { raw: '+55 48 9687-9719', ddd: '48', tail: '96879719' },
]

;(async () => {
  for (const t of targets) {
    // busca por LIKE — pega qualquer phone que termine no tail (capta com ou sem 9 inicial)
    const r = await axios.get(
      SUPA + `/orders?phone=like.*${t.tail}&select=id,phone,honoree_name,customer_name,plan,status,payment_amount,paid_at,preview_audio_url,original_audio_url,full_audio_urls,video_brinde_url&order=created_at.desc`,
      { headers: H }
    )
    console.log('\n═══', t.raw, '─ encontrados:', r.data.length)
    for (const o of r.data) {
      console.log('  id       :', o.id)
      console.log('  phone DB :', o.phone)
      console.log('  honoree  :', o.honoree_name)
      console.log('  customer :', o.customer_name)
      console.log('  plan     :', o.plan, '| amount:', o.payment_amount, '| status:', o.status)
      console.log('  paid_at  :', o.paid_at)
      console.log('  preview  :', o.preview_audio_url)
      console.log('  original :', o.original_audio_url)
      console.log('  full[1]  :', Array.isArray(o.full_audio_urls) ? o.full_audio_urls[1] : '-')
      console.log('  video    :', o.video_brinde_url)
      console.log()
    }
  }
})().catch(e => { console.error('ERR', e.message, JSON.stringify(e.response?.data)) })
