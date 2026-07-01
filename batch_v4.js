// Batch 2 do dia 07/06 — 13 contatos novos, numeração 10-22 (continua a anterior)
const axios = require('axios')
const fs = require('fs')
const path = require('path')

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const BASE = '/tmp/entregas/2026-06-07'

// debaixo pra cima do print: oldest msg first
const targets = [
  { n: '10', last4: '7237', tails: ['99747237', '9747237'] },             // 18 99747-7237
  { n: '11', last4: '4363', tails: ['88244363', '8244363'] },             // 41 8824-4363 (comprovante PDF)
  { n: '12', last4: '6386', tails: ['85526386', '5526386'] },             // 51 8552-6386 (Obrigada)
  { n: '13', last4: '3028', tails: ['84333028', '4333028'] },             // 98 8433-3028 (Quero a musica)
  { n: '14', last4: '1977', tails: ['97131977', '9713197', '7131977'] },  // 16 99713-1977 (Qual o valor?)
  { n: '15', last4: '6811', tails: ['91196811', '1196811'] },             // 48 9119-6811 (já entregue ontem - Vovó Maria)
  { n: '16', last4: '4197', tails: ['88664197', '8664197'] },             // 31 8866-4197 (Boa tarde)
  { n: '17', last4: '1089', tails: ['89521089', '9521089'] },             // 81 8952-1089 (Fiz. O pagamento e nao mandou)
  { n: '18', last4: '6647', tails: ['93940664', '3940664'] },             // 11 93940-6647 (Olá)
  { n: '19', last4: '4835', tails: ['91474835', '1474835'] },             // 44 9147-4835 (Valdir Cézar)
  { n: '20', last4: '8521', tails: ['99018521', '9018521'] },             // 79 9901-8521 (Alguem)
  { n: '21', last4: '3245', tails: ['96043245', '6043245'] },             // 84 9604-3245 (já entregue ontem - Heloo)
  { n: '22', last4: '2405', tails: ['99232405', '9232405'], idPrefix: 'bf1bcb6b' }, // 55 9923-2405 (#bf1bcb6b)
]

function safe(s) {
  return String(s || 'cliente').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_').slice(0, 30)
}

async function findOrder(t) {
  // 1) by id prefix (mais confiável quando temos #pedido)
  if (t.idPrefix) {
    const r = await axios.get(
      SUPA + `/orders?id=gte.${t.idPrefix}-0000-0000-0000-000000000000&id=lte.${t.idPrefix}-ffff-ffff-ffff-ffffffffffff&select=*`,
      { headers: H }
    )
    if (r.data.length) return r.data[0]
  }
  // 2) by phone tail
  for (const tail of t.tails) {
    const r = await axios.get(SUPA + `/orders?phone=like.*${tail}&select=*&order=created_at.desc&limit=10`, { headers: H })
    if (r.data.length) {
      const paid = r.data.find(o => o.status === 'paid')
      return paid || r.data[0]
    }
  }
  return null
}

async function dl(url, dest) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 })
  fs.writeFileSync(dest, Buffer.from(r.data))
  return r.data.byteLength
}

;(async () => {
  fs.mkdirSync(BASE, { recursive: true })
  const summary = []

  for (const t of targets) {
    const o = await findOrder(t)
    if (!o) {
      summary.push({ ...t, status: 'NAO_ENCONTRADO' })
      continue
    }
    const custName = safe(o.customer_name || 'cliente')
    const honName = safe(o.honoree_name || 'pessoa')
    const folderName = `${t.n}_${custName}_${t.last4}`
    const dir = path.join(BASE, folderName)
    fs.mkdirSync(dir, { recursive: true })

    const arr = Array.isArray(o.full_audio_urls) ? o.full_audio_urls.filter(Boolean) : []
    const audios = arr.length ? arr : (o.original_audio_url ? [o.original_audio_url] : [])
    const wantVideo = o.plan === 'completa' && !!o.video_brinde_url

    const info = {
      ...t,
      folder: folderName,
      orderId: o.id,
      customer: o.customer_name,
      honoree: o.honoree_name,
      phone: o.phone,
      status: o.status,
      plan: o.plan,
      amount: o.payment_amount,
      paid_at: o.paid_at,
      audios_count: audios.length,
      video: wantVideo ? 'sim' : (o.video_brinde_url ? 'gerado_mas_plano_musica' : 'nao'),
      files: [],
    }

    try {
      for (let i = 0; i < audios.length; i++) {
        const f = `Para_${honName}_v${i+1}.mp3`
        await dl(audios[i], path.join(dir, f))
        info.files.push(f)
      }
      if (wantVideo) {
        const f = `Para_${honName}.mp4`
        await dl(o.video_brinde_url, path.join(dir, f))
        info.files.push(f)
      }
    } catch (e) {
      info.error = e.message
    }
    summary.push(info)
  }

  console.log(JSON.stringify(summary, null, 2))
})().catch(e => console.error('ERR', e.message))
