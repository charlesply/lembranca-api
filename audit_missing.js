// Auditoria completa: lista TODAS orders sem URL de áudio nos últimos 7d
// (com diagnóstico detalhado pra cada uma)
const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const SUNO_KEY = process.env.SUNO_API_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

async function checkSuno(taskId) {
  if (!taskId) return null
  try {
    const r = await axios.get('https://api.sunoapi.org/api/v1/generate/record-info', {
      params: { taskId },
      headers: { Authorization: 'Bearer ' + SUNO_KEY },
      timeout: 15000,
    })
    const d = r.data?.data || {}
    const tracks = d.response?.sunoData || []
    return {
      status: d.status,
      errorCode: d.errorCode,
      tracks: tracks.length,
      audioUrls: tracks.map(t => t.audioUrl).filter(Boolean),
    }
  } catch (e) {
    return { error: e.message }
  }
}

;(async () => {
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
  // Pega TODAS as orders dos ultimos 7d com status preview_sent/paid/delivered
  // E SEM original_audio_url ou full_audio_urls
  const url = `${SUPA}/orders?status=in.(preview_sent,paid,delivered)&original_audio_url=is.null&created_at=gte.${since}&order=paid_at.desc.nullslast,created_at.desc&select=id,status,phone,paid_at,suno_task_id,suno_clip_ids,honoree_name,customer_name,plan,payment_amount,error_message,final_lyrics,created_at`
  const r = await axios.get(url, { headers: H })
  const orphans = r.data || []

  console.log(`═══ Auditoria — últimos 7 dias ═══\n`)
  console.log(`Orders sem original_audio_url: ${orphans.length}\n`)
  if (!orphans.length) {
    console.log('✅ NENHUMA órfã — tudo entregue corretamente')
    return
  }

  const paid = orphans.filter(o => o.status === 'paid')
  const notPaid = orphans.filter(o => o.status !== 'paid')
  console.log(`  💰 Pagas (URGENTE): ${paid.length}`)
  console.log(`  📝 Preview-sent (não pagas): ${notPaid.length}\n`)

  for (const o of orphans) {
    const tag = o.status === 'paid' ? '💰 PAGO' : '📝 preview'
    console.log(`─── ${tag} ${o.id.slice(0,8)} | ${o.honoree_name?.slice(0,30)} (${o.customer_name?.slice(0,25)})`)
    console.log(`    phone:${o.phone} | plan:${o.plan} R$${o.payment_amount} | paid_at:${o.paid_at?.slice(0,19) || '-'}`)
    console.log(`    task: ${o.suno_task_id?.slice(0,16) || 'NULL'}`)
    console.log(`    clip_ids: ${Array.isArray(o.suno_clip_ids) ? o.suno_clip_ids.length : 0}`)
    console.log(`    lyrics: ${o.final_lyrics ? 'sim' : 'NULL'}`)
    console.log(`    last error: ${(o.error_message || '-').slice(0, 80)}`)

    // Consulta Suno API
    if (o.suno_task_id) {
      const suno = await checkSuno(o.suno_task_id)
      if (suno) {
        if (suno.error) {
          console.log(`    Suno API: ERR ${suno.error}`)
        } else {
          console.log(`    Suno API: status=${suno.status} tracks=${suno.tracks}`)
          if (suno.audioUrls.length) {
            console.log(`    🎯 AUDIO URLS EXISTEM!`)
            suno.audioUrls.forEach((u, i) => console.log(`       v${i+1}: ${u}`))
          }
        }
      }
    }
    console.log()
  }
})().catch(e => console.error('FATAL:', e.message))
