// Aguarda regenerações terminarem e reporta status final
const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const TARGETS = [
  { id: 'e75f0d24-f36e-4ec8-ba1d-602d963d89f4', label: 'Edijenaldo → Helen' },
  { id: 'bf701596-2404-4bf2-bdf2-11795733b105', label: 'Claudia → filhos' },
]
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  let done = 0
  for (let i = 0; i < 18 && done < TARGETS.length; i++) {
    done = 0
    for (const t of TARGETS) {
      const r = await axios.get(`${SUPA}/orders?id=eq.${t.id}&select=original_audio_url,full_audio_urls,suno_task_id,video_brinde_url,plan`, { headers: H })
      const o = r.data[0]
      const hasUrls = Array.isArray(o.full_audio_urls) && o.full_audio_urls.length >= 1
      if (hasUrls) {
        done++
        console.log(`✅ ${t.label}: ${o.full_audio_urls.length} URL(s) | video=${o.video_brinde_url ? 'sim' : 'não'}`)
      }
    }
    if (done < TARGETS.length) {
      console.log(`(tick ${i+1}/30) aguardando ${TARGETS.length - done} restante(s)...`)
      await sleep(20000)
    }
  }
  console.log('\n═══ Estado final ═══')
  for (const t of TARGETS) {
    const r = await axios.get(`${SUPA}/orders?id=eq.${t.id}&select=*`, { headers: H })
    const o = r.data[0]
    console.log(`${t.label}:`)
    console.log('  task:', o.suno_task_id)
    console.log('  v1  :', Array.isArray(o.full_audio_urls) ? o.full_audio_urls[0] : 'NULL')
    console.log('  v2  :', Array.isArray(o.full_audio_urls) ? o.full_audio_urls[1] : 'NULL')
    console.log('  video:', o.video_brinde_url || 'NULL')
    console.log()
  }
})().catch(e => console.error('ERR', e.message))
