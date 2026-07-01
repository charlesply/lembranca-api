const axios = require('axios')
const KEY = process.env.SUNO_API_KEY
const SUPA = process.env.SUPABASE_URL
const SUPAKEY = process.env.SUPABASE_KEY
const H = { apikey: SUPAKEY, Authorization: 'Bearer ' + SUPAKEY }
const TASK = '3f09b7eb024a32d27e56cfe91ace333a'
const ORDER = 'e75f0d24-f36e-4ec8-ba1d-602d963d89f4'
;(async () => {
  const r = await axios.get('https://api.sunoapi.org/api/v1/generate/record-info', {
    params: { taskId: TASK }, headers: { Authorization: 'Bearer ' + KEY }, timeout: 30000,
  })
  console.log('status:', r.data?.data?.status)
  const tracks = r.data?.data?.response?.sunoData || r.data?.data?.response?.tracks || []
  console.log('tracks:', tracks.length)
  const urls = []
  tracks.forEach((t, i) => {
    const u = t.audioUrl || t.audio_url || t.sourceAudioUrl
    console.log('v' + (i+1) + ':', u)
    if (u) urls.push(u)
  })
  if (urls.length >= 1) {
    await axios.patch(SUPA + '/orders?id=eq.' + ORDER, {
      full_audio_urls: urls, original_audio_url: urls[0], suno_clip_ids: tracks.map(t => t.id),
    }, { headers: H })
    console.log('OK: DB atualizado com', urls.length, 'audios')
  }
})().catch(e => console.error('ERR', e.message))
