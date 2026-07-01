// Gera 2 PIX avulsos via AbacatePay (R$19,90 e R$29,90) pro Silvio
// finalizar manualmente. Usa o MESMO endpoint que o front (v2/transparents).
const axios = require('axios')
const KEY = process.env.ABACATEPAY_API_KEY
const API = 'https://api.abacatepay.com/v2'

async function createPix(cents, label) {
  const extId = `manual-murilo-${cents}-${Math.floor(Date.now() / 1000)}`
  try {
    const r = await axios.post(`${API}/transparents/create`, {
      method: 'PIX',
      data: {
        amount: cents,
        expiresIn: 24 * 60 * 60, // 24h
        description: label,
        externalId: extId,
        metadata: { context: 'manual_silvio_recovery', label },
      },
    }, {
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    })
    return r.data?.data
  } catch (e) {
    return { ERR: e.response?.status, body: e.response?.data || e.message }
  }
}

;(async () => {
  const [pix19, pix29] = await Promise.all([
    createPix(1990, 'Lembranca Cantada - Musica para Debora (R$19,90)'),
    createPix(2990, 'Lembranca Cantada - Musica para Debora Premium (R$29,90)'),
  ])

  for (const [label, p] of [['R$ 19,90', pix19], ['R$ 29,90', pix29]]) {
    console.log('═══', label, '═══')
    if (p.ERR) { console.log('  ERRO:', p.ERR, JSON.stringify(p.body)); continue }
    console.log('  id        :', p.id)
    console.log('  brCode    :')
    console.log('  ' + p.brCode)
    console.log('  expiresAt :', p.expiresAt)
    console.log()
  }
})()
