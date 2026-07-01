const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const PREFIX = process.argv[2] || 'bfcc155a'

;(async () => {
  const r = await axios.get(
    SUPA + `/orders?id=gte.${PREFIX}-0000-0000-0000-000000000000&id=lte.${PREFIX}-ffff-ffff-ffff-ffffffffffff&select=*`,
    { headers: H }
  )
  if (!r.data.length) return console.log('Nenhum pedido com prefix', PREFIX)
  const o = r.data[0]
  console.log('═══ ORDER', o.id, '═══')
  console.log('phone        :', o.phone)
  console.log('honoree      :', o.honoree_name)
  console.log('customer     :', o.customer_name)
  console.log('relationship :', o.relationship)
  console.log('occasion     :', o.occasion)
  console.log('plan         :', o.plan, '| amount:', o.payment_amount)
  console.log('status       :', o.status, '| paid_at:', o.paid_at)
  console.log('capi sent    :', o.meta_capi_sent, '| at:', o.meta_capi_sent_at)
  console.log()
  console.log('original :', o.original_audio_url)
  const arr = Array.isArray(o.full_audio_urls) ? o.full_audio_urls : []
  arr.forEach((u, i) => console.log(`v${i+1}     :`, u))
  console.log('video    :', o.video_brinde_url)
})().catch(e => console.error('ERR', e.message))
