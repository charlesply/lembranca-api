const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const CHARGE = 'pix_char_5UCcZcLbWT0RJ3u4wSmMCWe1'

;(async () => {
  const r = await axios.get(
    SUPA + `/orders?or=(abacate_charge_id.eq.${CHARGE},bill_id.eq.${CHARGE})&select=*`,
    { headers: H }
  )
  if (!r.data.length) return console.log('Nenhum pedido com esse charge_id')
  const o = r.data[0]
  console.log('═══ ORDER ═══')
  console.log('id           :', o.id)
  console.log('phone        :', o.phone)
  console.log('honoree      :', o.honoree_name)
  console.log('customer     :', o.customer_name)
  console.log('plan         :', o.plan, '| amount:', o.payment_amount)
  console.log('status       :', o.status, '| paid_at:', o.paid_at)
  console.log('fbp_pixel_id :', o.fbp_pixel_id)
  console.log('capi sent    :', o.meta_capi_sent, '| at:', o.meta_capi_sent_at)
  console.log()
  console.log('original_audio_url:', o.original_audio_url)
  const arr = Array.isArray(o.full_audio_urls) ? o.full_audio_urls : []
  arr.forEach((u, i) => console.log(`full v${i+1}:`, u))
  console.log('video        :', o.video_brinde_url)
  console.log()
  console.log('story (200)  :', (o.story || '').slice(0, 200))
})().catch(e => console.error('ERR', e.message))
