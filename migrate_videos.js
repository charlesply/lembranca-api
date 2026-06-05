// Migração one-shot: re-upload vídeos do Supabase do amigo (wedkbwsi...)
// pro Supabase do user (cmoxre...). Só roda em orders com abacate_charge_id
// (= geradas pelo lembranca-api). Atualiza video_brinde_url no final.
//
// Uso: docker exec CONTAINER node /app/migrate_videos.js

const axios = require('axios')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const STORAGE_BASE = SUPABASE_URL.replace('/rest/v1', '') + '/storage/v1'
const BUCKET = 'videos'
const CONCURRENCY = 4

function supaHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

async function fetchOrders() {
  const filter = "video_brinde_url=like.%25wedkbwsijfikbkaqnugz%25&abacate_charge_id=not.is.null"
  const r = await axios.get(
    `${SUPABASE_URL}/orders?${filter}&select=id,honoree_name,video_brinde_url&order=created_at.asc`,
    { headers: supaHeaders(), timeout: 30000 }
  )
  return r.data || []
}

async function migrateOne(order) {
  const oldUrl = order.video_brinde_url
  const filename = oldUrl.split('/').pop().split('?')[0]
  const newPublicUrl = `${STORAGE_BASE}/object/public/${BUCKET}/${filename}`

  try {
    // baixa do Supabase do amigo (URL pública)
    const download = await axios.get(oldUrl, { responseType: 'arraybuffer', timeout: 60000 })
    const buf = Buffer.from(download.data)
    const sizeKB = Math.round(buf.length / 1024)

    // upload pro meu Supabase (upsert true sobrescreve se já existir)
    await axios.post(
      `${STORAGE_BASE}/object/${BUCKET}/${filename}`,
      buf,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
      }
    )

    // atualiza URL na order
    await axios.patch(
      `${SUPABASE_URL}/orders?id=eq.${order.id}`,
      { video_brinde_url: newPublicUrl },
      { headers: supaHeaders(), timeout: 15000 }
    )

    console.log(`✅ ${order.id.slice(0,8)} | ${order.honoree_name?.slice(0,25) || '?'} | ${sizeKB}KB | ${filename}`)
    return { ok: true, id: order.id }
  } catch (e) {
    const msg = e.response?.status ? `${e.response.status} ${e.response.statusText}` : e.message
    console.error(`❌ ${order.id.slice(0,8)} | ${order.honoree_name?.slice(0,25) || '?'} | ${filename} | ${msg}`)
    return { ok: false, id: order.id, error: msg }
  }
}

async function runBatch(items, fn, concurrency = 4) {
  const out = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const r = await Promise.all(batch.map(fn))
    out.push(...r)
  }
  return out
}

;(async () => {
  console.log('═══ Migração de vídeos: Supabase do amigo → seu ═══')
  const orders = await fetchOrders()
  console.log(`Total a migrar: ${orders.length}\n`)
  if (!orders.length) { console.log('Nada a fazer ✅'); return }

  const results = await runBatch(orders, migrateOne, CONCURRENCY)
  const ok = results.filter(r => r.ok).length
  const fail = results.filter(r => !r.ok).length
  console.log(`\n═══ Resumo: ${ok} sucesso · ${fail} falha ═══`)
  if (fail) {
    console.log('Falhas:')
    results.filter(r => !r.ok).forEach(r => console.log(' ', r.id.slice(0,8), r.error))
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
