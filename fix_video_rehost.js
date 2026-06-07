// Conserta videos com URL externa autenticada (video-suno-api) salvos
// no DB por engano. Baixa com X-API-Key, re-upa no nosso Supabase,
// atualiza video_brinde_url.
const axios = require('axios')

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const VIDEO_API = process.env.VIDEO_API_URL || 'http://video-suno-api.linkarbox.app'
const VIDEO_KEY = process.env.VIDEO_API_KEY || 'hc_7SPoyZxHpLwpxjyfWBwRdJB6Mpf75hvU08N9fhmzd-g'
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const orderIds = [
  'c1443dff-b2ce-4ede-ba2a-f21a32560f10', // Gabriel → Francieli (completa)
  'bc0837c1-c0aa-4e3a-b96a-3637100fb8ac', // Paulo → Paula Rita (musica — mas gera video brinde mesmo assim)
]

async function rehostOne(orderId) {
  const r = await axios.get(SUPA + `/orders?id=eq.${orderId}&select=id,honoree_name,plan,video_brinde_url`, { headers: H })
  const o = r.data?.[0]
  if (!o || !o.video_brinde_url) return { id: orderId, skipped: 'no video_url' }
  if (o.video_brinde_url.includes('cmoxrejqvdpdiugbsdcz')) {
    return { id: orderId, skipped: 'já no nosso Supabase' }
  }

  // Extrai jobId da URL /api/jobs/{jobId}/video
  const jobMatch = /\/jobs\/([a-zA-Z0-9_-]+)/.exec(o.video_brinde_url)
  if (!jobMatch) return { id: orderId, error: 'jobId não extraído', url: o.video_brinde_url }
  const jobId = jobMatch[1]

  // Tenta pegar public_url via /api/jobs/{id}
  let videoUrl = null
  try {
    const j = await axios.get(`${VIDEO_API}/api/jobs/${jobId}`, {
      headers: { 'X-API-Key': VIDEO_KEY }, timeout: 15000,
    })
    videoUrl = j.data?.public_url || null
    if (!videoUrl) {
      // public_url não disponível — baixa pela URL autenticada
      videoUrl = `${VIDEO_API}/api/jobs/${jobId}/video`
    }
  } catch (e) {
    return { id: orderId, error: 'job lookup: ' + e.message }
  }

  // Baixa o vídeo (com X-API-Key caso URL precise)
  let buf
  try {
    const dl = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      headers: { 'X-API-Key': VIDEO_KEY },
      timeout: 120000,
    })
    buf = Buffer.from(dl.data)
  } catch (e) {
    return { id: orderId, error: 'download: ' + (e.response?.status || e.message) }
  }

  // Gera nome único pelo jobId
  const STORAGE_BASE = SUPA.replace('/rest/v1', '') + '/storage/v1'
  const filename = `${jobId}.mp4`
  try {
    await axios.post(
      `${STORAGE_BASE}/object/videos/${filename}`,
      buf,
      {
        headers: {
          Authorization: 'Bearer ' + KEY,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true',
        },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000,
      }
    )
  } catch (e) {
    return { id: orderId, error: 'upload: ' + (e.response?.status || e.message) }
  }

  const newUrl = `${STORAGE_BASE}/object/public/videos/${filename}`
  await axios.patch(SUPA + `/orders?id=eq.${orderId}`, { video_brinde_url: newUrl }, { headers: H })

  return { id: orderId, ok: true, honoree: o.honoree_name, sizeMB: Math.round(buf.length/1024/1024 * 10)/10, newUrl }
}

;(async () => {
  for (const id of orderIds) {
    const r = await rehostOne(id)
    console.log(JSON.stringify(r, null, 2))
  }
})().catch(e => console.error('FATAL', e.message))
