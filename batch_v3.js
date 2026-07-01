// Batch lookup + download, pasta data específica
const axios = require('axios')
const fs = require('fs')
const path = require('path')

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const BASE = '/tmp/entregas/2026-06-07'

// debaixo pra cima
const targets = [
  { n: '01', last4: '5631', tails: ['81155631', '1155631'] },        // 77 8115-5631 (Rita Pinheiro)
  { n: '02', last4: '2825', tails: ['87072825', '7072825'] },        // 31 8707-2825 (Keila silva)
  { n: '03', last4: '6348', tails: ['92886348', '2886348'] },        // 31 9288-6348
  { n: '04', last4: '9500', tails: ['81189500', '1189500'] },        // 54 8118-9500 (Rosemeri)
  { n: '05', last4: '2762', tails: ['91102762', '1102762'] },        // 93 9110-2762
  { n: '06', last4: '1671', tails: ['87161671', '7161671'] },        // 98 8716-1671
  { n: '07', last4: '2007', tails: ['81652007', '1652007'] },        // 87 8165-2007 (Joseline)
  { n: '08', last4: '4499', tails: ['68854499', '8854499'] },        // 21 96885-4499 (Elca machado)
  { n: '09', last4: '4751', tails: ['86864751', '6864751'] },        // 31 8686-4751
]

function safe(s) {
  return String(s || 'cliente').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_').slice(0, 30)
}

async function findOrder(t) {
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
