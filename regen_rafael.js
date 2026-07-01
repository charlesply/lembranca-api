// Regenera a música do Rafael (Talita) que falhou no Suno.
// Submete novo job e atualiza suno_task_id no DB.
const axios = require('axios')
const KEY = process.env.SUNO_API_KEY
const SUPA = process.env.SUPABASE_URL
const SUPAKEY = process.env.SUPABASE_KEY
const H = { apikey: SUPAKEY, Authorization: 'Bearer ' + SUPAKEY }
const ORDER_ID = '9ff540bc-2c90-42f5-bc1d-fd85b25a0faf'

const LYRICS = `Nos conhecemos pela tela, um mundo a desbravar,
Talita, minha estrela, que veio pra me guiar.
Nos fins de semana, pegava o ônibus a sonhar,
Teus olhos, um encanto, não podia mais esperar.

Talita, meu amor, a cada passo que eu dou,
Teu carinho me envolve e a saudade aumentou.
Te protegendo, cuidando, sempre ao meu lado,
Em cada momento, eu sou teu apaixonado.

Lembro do nosso encontro, a emoção no olhar,
Pegando aquele ônibus, só pra te encontrar.
Teu sorriso me encanta, me faz sentir tão bem,
Eu sou grato por tudo, por você, meu bem.

Talita, meu amor, a cada passo que eu dou,
Teu carinho me envolve e a saudade aumentou.
Te protegendo, cuidando, sempre ao meu lado,
Em cada momento, eu sou teu apaixonado.

E quando a noite chega, sonho em te abraçar,
Na brisa do bosque, a nossa história a flutuar.

Talita, meu amor, a cada passo que eu dou,
Teu carinho me envolve e a saudade aumentou.
Te protegendo, cuidando, sempre ao meu lado,
Em cada momento, eu sou teu apaixonado.

Com você, eu vou além, sempre com amor no coração.`

;(async () => {
  const cbUrl = process.env.SUNOAPI_CALLBACK_URL || 'https://suno-api-novo.bvph.uk/api/webhooks/sunoapi'
  const body = {
    model: 'V5_5',
    customMode: true,
    instrumental: false,
    prompt: LYRICS,
    style: 'Sertanejo Romântico Brasileiro',
    title: 'Para Talita',
    callBackUrl: cbUrl,
    vocalGender: 'm',
  }
  const r = await axios.post('https://api.sunoapi.org/api/v1/generate', body, {
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    timeout: 30000,
  })
  console.log('code:', r.data?.code, 'msg:', r.data?.msg)
  const taskId = r.data?.data?.taskId
  if (!taskId) {
    console.log('FAIL submit:', JSON.stringify(r.data).slice(0, 300))
    return
  }
  console.log('✅ new taskId:', taskId)
  await axios.patch(SUPA + '/orders?id=eq.' + ORDER_ID, {
    suno_task_id: taskId,
    status: 'paid', // mantem paid
  }, { headers: H })
  console.log('✅ suno_task_id atualizado no DB')
  console.log('\n>>> Aguarda 2-5min e roda novamente o rescue pra puxar os mp3s.')
})().catch(e => console.error('ERR', e.message, JSON.stringify(e.response?.data || '').slice(0, 300)))
