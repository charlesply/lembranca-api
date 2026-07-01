// UUIDs nao aceitam LIKE direto no PostgREST. Lista as orders dos ultimos 14d e filtra no JS.
const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const PREFIX = '66d65e38' // primeiros 8 chars do UUID

;(async () => {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()
  const r = await axios.get(
    SUPA + `/orders?created_at=gte.${since}&select=id,honoree_name,customer_name,phone,plan,payment_amount,status,paid_at,preview_audio_url,original_audio_url,full_audio_urls,video_brinde_url&order=created_at.desc&limit=1000`,
    { headers: H }
  )
  const found = r.data.filter(o => String(o.id || '').toLowerCase().startsWith(PREFIX.toLowerCase()))
  console.log('candidatos com prefix', PREFIX, ':', found.length, '(scanned', r.data.length, 'orders dos ultimos 14d)')
  for (const o of found) {
    console.log('\n═══', o.id, '═══')
    console.log('honoree     :', o.honoree_name)
    console.log('customer    :', o.customer_name)
    console.log('phone       :', o.phone)
    console.log('plan        :', o.plan, '| amount:', o.payment_amount, '| status:', o.status)
    console.log('paid_at     :', o.paid_at)
    const arr = Array.isArray(o.full_audio_urls) ? o.full_audio_urls : []
    arr.forEach((u, i) => console.log(`v${i+1}        :`, u))
    if (!arr.length) console.log('original    :', o.original_audio_url)
    console.log('video       :', o.video_brinde_url)
  }
})().catch(e => console.error('ERR', e.message))
