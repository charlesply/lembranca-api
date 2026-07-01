const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

// 11 95931-6737 → tail 959316737 ou 95931-6737
const tail = '98071149'
;(async () => {
  const r = await axios.get(
    SUPA + `/orders?phone=like.*${tail}*&select=*&order=created_at.asc`,
    { headers: H }
  )
  console.log('total:', r.data.length, '\n')
  let i = 1
  for (const o of r.data) {
    console.log('═══ TENTATIVA', i++, '═══')
    console.log('id           :', o.id)
    console.log('phone DB     :', o.phone)
    console.log('created_at   :', o.created_at)
    console.log('status       :', o.status)
    console.log('honoree_name :', o.honoree_name)
    console.log('customer_name:', o.customer_name)
    console.log('relationship :', o.relationship)
    console.log('occasion     :', o.occasion)
    console.log('genre        :', o.genre)
    console.log('mood         :', o.mood)
    console.log('voice_pref   :', o.voice_preference)
    console.log('plan         :', o.plan)
    console.log('amount       :', o.payment_amount)
    console.log('paid_at      :', o.paid_at)
    console.log('preview      :', o.preview_audio_url)
    console.log('original     :', o.original_audio_url)
    console.log('full[1]      :', Array.isArray(o.full_audio_urls) ? o.full_audio_urls[1] : '-')
    console.log('video        :', o.video_brinde_url)
    console.log('story (200)  :', (o.story || '').slice(0, 200))
    console.log()
  }
})().catch(e => console.error('ERR', e.message))
