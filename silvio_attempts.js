// Le as 2 tentativas do Silvio pra mostrar diferencas (estilo, occasion, story etc)
const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

;(async () => {
  const r = await axios.get(
    SUPA + '/orders?phone=eq.42999734849&select=*&order=created_at.asc',
    { headers: H }
  )
  console.log('total:', r.data.length, '\n')
  let i = 1
  for (const o of r.data) {
    console.log('═══ TENTATIVA', i++, '═══')
    console.log('id           :', o.id)
    console.log('created_at   :', o.created_at)
    console.log('status       :', o.status)
    console.log('honoree_name :', o.honoree_name)
    console.log('customer_name:', o.customer_name)
    console.log('relationship :', o.relationship)
    console.log('occasion     :', o.occasion)
    console.log('genre        :', o.genre)
    console.log('mood         :', o.mood)
    console.log('voice_pref   :', o.voice_preference)
    console.log('style_raw    :', o.style_raw)
    console.log('story (200)  :', (o.story || '').slice(0, 200))
    console.log('preview_url  :', o.preview_audio_url)
    console.log('paid_at      :', o.paid_at)
    console.log()
  }
})().catch(e => console.error('ERR', e.message))
