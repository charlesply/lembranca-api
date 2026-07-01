// Busca por tel, e p/ cada pedido pago baixa os arquivos em /tmp/entregas/NN_Nome_XXXX/
// Ordem dada pelo user: debaixo pra cima do print do WhatsApp.
const axios = require('axios')
const fs = require('fs')
const path = require('path')

const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

// debaixo pra cima (sem o 6494 que ja foi entregue):
const targets = [
  { n: '01', last4: '3652', tails: ['81953652', '195365'] },     // 98 8195-3652
  { n: '02', last4: '1560', tails: ['98151560', '8151560'] },   // 88 9815-1560
  { n: '03', last4: '6006', tails: ['96156006', '6156006'] },   // 88 9615-6006
  { n: '04', last4: '0723', tails: ['83030723', '3030723'] },   // 91 8303-0723
  { n: '05', last4: '1747', tails: ['84021747', '4021747'] },   // 96 8402-1747
  { n: '06', last4: '5251', tails: ['88725251', '8725251'] },   // 43 8872-5251
  { n: '07', last4: '3245', tails: ['96043245', '6043245'] },   // 84 9604-3245
  { n: '08', last4: '6811', tails: ['91196811', '1196811'] },   // 48 9119-6811
  { n: '09', last4: '4952', tails: ['94554952', '4554952'] },   // 86 9455-4952
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
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 90000 })
  fs.writeFileSync(dest, Buffer.from(r.data))
  return r.data.byteLength
}

;(async () => {
  const baseDir = '/tmp/entregas'
  fs.mkdirSync(baseDir, { recursive: true })

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
    const dir = path.join(baseDir, folderName)
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
