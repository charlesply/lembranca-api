// Tenta varios endpoints AbacatePay pra descobrir como listar/consultar charges com disputa
const axios = require('axios')
const KEY = process.env.ABACATEPAY_API_KEY

const tryE = async (method, path, body) => {
  try {
    const cfg = { headers: { Authorization: 'Bearer ' + KEY, 'X-API-Version': '2025-01-01', 'api-version': '2', 'X-API-Key': KEY }, timeout: 15000 }
    const r = method === 'GET'
      ? await axios.get('https://api.abacatepay.com' + path, cfg)
      : await axios.post('https://api.abacatepay.com' + path, body || {}, cfg)
    return { status: r.status, data: r.data }
  } catch (e) {
    return { ERR: e.response?.status, body: e.response?.data || e.message }
  }
}

;(async () => {
  // Tenta GET de um charge especifico (Simaria, que pagou segundos antes da disputa 12:08)
  const id = 'pix_char_PNeqyXtJ63xjMuD2LckkxXCm'
  const paths = [
    `/v1/billing/list`,
    `/v2/billing/list`,
    `/v1/pixQrCode/list`,
    `/v1/account`,
    `/v1/me`,
    `/v1/store`,
    `/v1/disputes/list`,
    `/v1/dispute/list`,
  ]
  for (const p of paths) {
    const r = await tryE('GET', p)
    console.log(p, '→', r.status || r.ERR, '|', JSON.stringify(r.data || r.body).slice(0, 200))
  }
})()
