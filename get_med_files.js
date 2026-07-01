const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const ids = [
  { who: 'Cleocilene → Sâmara (R$29,90)', id: '8fccbb33-a975-4488-9425-34813300e401' },
  { who: 'Josilene → Isabelli (R$19,90)', id: '810db95f-62d8-4a01-a11f-c6f09fe35548' },
]

;(async () => {
  for (const t of ids) {
    const r = await axios.get(SUPA + `/orders?id=eq.${t.id}&select=full_audio_urls,original_audio_url,video_brinde_url,honoree_name`, { headers: H })
    const o = r.data[0]
    console.log('═══', t.who, '═══')
    console.log('  honoree:', o.honoree_name)
    const arr = Array.isArray(o.full_audio_urls) ? o.full_audio_urls : []
    arr.forEach((u, i) => console.log(`  v${i+1}:`, u))
    if (!arr.length) console.log('  original:', o.original_audio_url)
    console.log('  video:', o.video_brinde_url)
    console.log()
  }
})().catch(e => console.error('ERR', e.message))
