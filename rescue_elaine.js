// Resgata os audios da Elaine direto da Suno API e atualiza o pedido.
const axios = require('axios')
const KEY = process.env.SUNO_API_KEY
const SUPA = process.env.SUPABASE_URL
const SUPAKEY = process.env.SUPABASE_KEY
const H = { apikey: SUPAKEY, Authorization: 'Bearer ' + SUPAKEY }

const TASK_ID = 'ed42ce02691c8ba0272c0af9ae54fb30'
const ORDER_ID = '9ff540bc-2c90-42f5-bc1d-fd85b25a0faf'

;(async () => {
  const r = await axios.get('https://api.sunoapi.org/api/v1/generate/record-info', {
    params: { taskId: TASK_ID },
    headers: { Authorization: 'Bearer ' + KEY },
    timeout: 30000,
  })
  console.log('code:', r.data?.code, 'msg:', r.data?.msg)
  const data = r.data?.data
  console.log('status:', data?.status, '| type:', data?.type)
  const tracks = data?.response?.sunoData || data?.response?.tracks || []
  console.log('\nTracks:', tracks.length)
  const urls = []
  tracks.forEach((t, i) => {
    console.log(`\n[${i+1}] id=${t.id}`)
    console.log('    audio_url    :', t.audioUrl || t.audio_url)
    console.log('    source_audio :', t.sourceAudioUrl || t.source_audio_url)
    console.log('    stream       :', t.streamAudioUrl || t.stream_audio_url)
    console.log('    title        :', t.title)
    console.log('    duration     :', t.duration)
    const url = t.audioUrl || t.audio_url || t.sourceAudioUrl
    if (url) urls.push(url)
  })

  if (urls.length) {
    console.log('\n>>> Atualizando pedido com', urls.length, 'audios...')
    const patch = {
      full_audio_urls: urls,
      original_audio_url: urls[0],
      suno_clip_ids: tracks.map(t => t.id),
    }
    await axios.patch(SUPA + '/orders?id=eq.' + ORDER_ID, patch, { headers: H })
    console.log('✅ pedido atualizado')
  }
})().catch(e => console.error('ERR', e.message, JSON.stringify(e.response?.data || '').slice(0, 200)))
