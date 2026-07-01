const axios = require('axios')
const SUPA = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_KEY
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const ids = [
  'pix_char_xAMUXUHFzRZSHypfx0AT6FXX', // R$29,90 disputa 14:46
  'pix_char_DDd1QqJFYFuxnmGbHCESZutn', // R$19,90 disputa 12:08
]

;(async () => {
  for (const cid of ids) {
    const r = await axios.get(
      SUPA + '/orders?abacate_charge_id=eq.' + cid + '&select=*',
      { headers: H }
    )
    const o = r.data[0]
    if (!o) { console.log(cid, '→ não encontrado'); continue }
    console.log('═══', cid)
    console.log('  order id:', o.id)
    console.log('  honoree :', o.honoree_name)
    console.log('  customer:', o.customer_name)
    console.log('  whatsapp:', o.customer_whatsapp || o.phone || o.whatsapp || '(sem campo)')
    console.log('  email   :', o.customer_email || o.email || '(sem campo)')
    console.log('  plan    :', o.plan, '| amount:', o.payment_amount)
    console.log('  status  :', o.status, '| paid_at:', o.paid_at)
    console.log('  preview :', o.preview_audio_url)
    console.log('  full    :', o.original_audio_url)
    console.log('  video   :', o.video_brinde_url)
    console.log('  fbp     :', o.fbp_pixel_id)
    console.log('  delivered:', o.delivered_at)
    // tudo q tem 'phone', 'whats', 'mail'
    const keys = Object.keys(o).filter(k => /phone|whats|mail|contact/i.test(k))
    console.log('  campos contato:', keys.map(k => k+'='+o[k]).join(' | '))
    console.log()
  }
})().catch(e => { console.error('ERR', e.message, JSON.stringify(e.response?.data)) })
