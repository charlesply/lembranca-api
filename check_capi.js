const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

;(async () => {
  // Procura por prefix 66d65e38
  const r = await axios.get(
    SUPA + `/orders?id=gte.66d65e38-0000-0000-0000-000000000000&id=lte.66d65e38-ffff-ffff-ffff-ffffffffffff&select=id,honoree_name,customer_name,phone,plan,payment_amount,status,paid_at,fbp_pixel_id,meta_capi_sent,meta_capi_sent_at,abacate_charge_id`,
    { headers: H }
  )
  for (const o of r.data) {
    console.log('═══', o.id)
    for (const k of Object.keys(o)) console.log(' ', k.padEnd(20), o[k])
    console.log()
  }
})().catch(e => console.error('ERR', e.message))
