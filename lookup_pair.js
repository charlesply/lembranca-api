const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const targets = [
  { tag: '6844', tails: ['98016844', '8016844'] },     // 42 9801-6844
  { tag: '8393', tails: ['99630839', '99630-8', '96308393'] }, // 21 99630-8393
]

;(async () => {
  for (const t of targets) {
    let rows = []
    for (const tail of t.tails) {
      const r = await axios.get(SUPA + `/orders?phone=like.*${tail}*&select=id,phone,customer_name,honoree_name,plan,payment_amount,status,paid_at,original_audio_url,full_audio_urls,video_brinde_url,suno_task_id,occasion,relationship,style_raw&order=created_at.desc&limit=10`, { headers: H })
      if (r.data.length) { rows = r.data; break }
    }
    console.log('═══', t.tag, '═══')
    if (!rows.length) { console.log('  ❌ não encontrado\n'); continue }
    const paid = rows.find(o => o.status === 'paid')
    const o = paid || rows[0]
    console.log('  id:', o.id)
    console.log('  phone:', o.phone)
    console.log('  customer:', o.customer_name, '→ honoree:', o.honoree_name)
    console.log('  occasion:', o.occasion, '| rel:', o.relationship, '| style:', o.style_raw)
    console.log('  plan:', o.plan, '| R$', o.payment_amount, '| status:', o.status)
    console.log('  paid_at:', o.paid_at)
    const arr = Array.isArray(o.full_audio_urls) ? o.full_audio_urls : []
    arr.forEach((u, i) => console.log(`  v${i+1}:`, u))
    if (!arr.length && o.original_audio_url) console.log('  original:', o.original_audio_url)
    console.log('  video:', o.video_brinde_url)
    console.log('  suno_task:', o.suno_task_id)
    if (rows.length > 1) console.log('  (+', rows.length - 1, 'tentativas extra)')
    console.log()
  }
})().catch(e => console.error('ERR', e.message))
