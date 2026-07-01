// ═══════════════════════════════════════════════════════════════════════════
// Varredura COMPLETA: encontra TODAS as orders com suno_task_id mas sem
// original_audio_url, tenta resgatar via fallback (cdn1.suno.ai/{clipId}),
// e pra as que falharam (Suno realmente FAILED), regenera via API com a
// final_lyrics original.
//
// Prioriza pagos (paid) sobre não-pagos. Roda sequencial pra não estourar
// rate limit da Suno.
// ═══════════════════════════════════════════════════════════════════════════
const axios = require('axios')
const { ensureAudioUrls } = require('./lib/sunoFallback')

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const SUNO_KEY = process.env.SUNO_API_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const LOOKBACK_DAYS = 30
const SUNO_BASE = 'https://api.sunoapi.org'
const CALLBACK_URL = process.env.SUNOAPI_CALLBACK_URL
  || 'https://suno-api-novo.bvph.uk/api/webhooks/sunoapi'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function findOrphans() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString()
  const url = `${SUPA}/orders?status=in.(preview_sent,paid,delivered)&suno_task_id=not.is.null&original_audio_url=is.null&created_at=gte.${since}&order=paid_at.desc.nullslast,created_at.desc&select=id,status,paid_at,suno_task_id,suno_clip_ids,honoree_name,customer_name,phone,plan,payment_amount,final_lyrics,style_raw,voice_preference`
  const r = await axios.get(url, { headers: H, timeout: 30000 })
  return r.data || []
}

async function regenerate(order) {
  if (!order.final_lyrics) {
    return { ok: false, reason: 'no_lyrics' }
  }
  const voiceMap = { 'Masculino': 'm', 'Feminino': 'f' }
  const body = {
    model: 'V5_5',
    customMode: true,
    instrumental: false,
    prompt: String(order.final_lyrics).slice(0, 5000),
    style: String(order.style_raw || 'Sertanejo Romântico').slice(0, 1000),
    title: ('Para ' + (order.honoree_name || 'voce')).slice(0, 100),
    callBackUrl: CALLBACK_URL,
  }
  const vg = voiceMap[order.voice_preference]
  if (vg) body.vocalGender = vg

  try {
    const r = await axios.post(`${SUNO_BASE}/api/v1/generate`, body, {
      headers: { Authorization: 'Bearer ' + SUNO_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
    })
    const taskId = r.data?.data?.taskId
    if (!taskId) return { ok: false, reason: 'submit_no_taskId', resp: r.data }

    // Atualiza suno_task_id no DB pra o webhook achar
    await axios.patch(`${SUPA}/orders?id=eq.${order.id}`, {
      suno_task_id: taskId,
      error_message: `[regen ${new Date().toISOString().slice(0,19)}] novo taskId=${taskId.slice(0,12)}`,
    }, { headers: H })
    return { ok: true, taskId }
  } catch (e) {
    return { ok: false, reason: 'submit_error', err: e.message }
  }
}

;(async () => {
  console.log(`═══ Varredura órfãs (lookback ${LOOKBACK_DAYS}d) ═══\n`)
  const orphans = await findOrphans()
  console.log(`Total encontradas: ${orphans.length}\n`)
  if (!orphans.length) return

  const result = { rescued: [], regenerated: [], failed: [], skipped: [] }

  for (const o of orphans) {
    const tag = `${o.id.slice(0,8)} ${(o.status === 'paid' ? '💰' : '·')} ${o.honoree_name?.slice(0,20)}`
    process.stdout.write(`${tag} ... `)

    // Tenta resgatar via fallback (URL existe mas DB não tem)
    const r = await ensureAudioUrls(o.id, { maxRetries: 2, baseDelayMs: 2000 })
    if (r.ok) {
      console.log(`✅ resgatado (${r.source})`)
      result.rescued.push(o.id)
      continue
    }

    // Falhou — só regenera se status=paid (cliente que pagou tem prioridade)
    if (o.status !== 'paid') {
      console.log(`⏭ skip (status=${o.status}, sem áudio recuperável — só regenera pagos)`)
      result.skipped.push(o.id)
      continue
    }

    // Regenera
    process.stdout.write(`falha fallback → regerando... `)
    const reg = await regenerate(o)
    if (reg.ok) {
      console.log(`✅ submetido (newTaskId=${reg.taskId.slice(0,12)})`)
      result.regenerated.push({ id: o.id, taskId: reg.taskId })
    } else {
      console.log(`❌ ${reg.reason}`)
      result.failed.push({ id: o.id, reason: reg.reason })
    }

    // Rate limit Suno
    await sleep(3000)
  }

  console.log(`\n═══ RESUMO ═══`)
  console.log(`✅ Resgatadas (URL existia): ${result.rescued.length}`)
  console.log(`🔄 Regeneradas (paid sem áudio): ${result.regenerated.length}`)
  console.log(`⏭ Skip (não pago, sem regenerar): ${result.skipped.length}`)
  console.log(`❌ Falha: ${result.failed.length}`)
  if (result.regenerated.length) {
    console.log(`\nIDs regeneradas:`)
    result.regenerated.forEach(r => console.log(`  ${r.id} → ${r.taskId}`))
  }
  if (result.failed.length) {
    console.log(`\nFalhas:`)
    result.failed.forEach(f => console.log(`  ${f.id} → ${f.reason}`))
  }
})().catch(e => console.error('FATAL:', e.message))
