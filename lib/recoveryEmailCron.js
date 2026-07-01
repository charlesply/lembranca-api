// Cron da RECUPERAÇÃO ATIVA por e-mail. Pega prévias não-pagas com ~7min e manda
// o e-mail de recuperação (A/B). DESLIGADO por padrão — só roda com
// RECOVERY_EMAIL_ENABLED=true. Janela 7–45min pra NÃO disparar o backlog antigo
// inteiro ao ligar (só pega prévias recentes; daí pra frente, toda prévia nova).
const { supaFetch } = require('./supabase')
const { sendRecoveryEmail } = require('./recoveryEmail')

const MIN_AGE_MIN = parseInt(process.env.RECOVERY_MIN_AGE_MIN || '7', 10)   // dispara após 7min
const MAX_AGE_MIN = parseInt(process.env.RECOVERY_MAX_AGE_MIN || '45', 10)  // ignora >45min (evita blast do backlog)
const PER_RUN = parseInt(process.env.RECOVERY_PER_RUN || '40', 10)
const INTERVAL_MIN = parseInt(process.env.RECOVERY_INTERVAL_MIN || '2', 10)
let _timer = null

async function runRecoveryOnce() {
  if (String(process.env.RECOVERY_EMAIL_ENABLED || '') !== 'true') return; // 🔒 desligado por padrão
  try {
    const now = Date.now()
    const hi = new Date(now - MIN_AGE_MIN * 60000).toISOString()
    const lo = new Date(now - MAX_AGE_MIN * 60000).toISOString()
    const cols = 'id,honoree_name,customer_name,customer_email,email_opt_out,recovery_email_sent'
    const q = `orders?status=eq.preview_sent&paid_at=is.null&recovery_email_sent=eq.false&email_opt_out=eq.false`
      + `&customer_email=not.is.null&preview_sent_at=gte.${lo}&preview_sent_at=lte.${hi}`
      + `&select=${cols}&order=preview_sent_at.asc&limit=${PER_RUN}`
    const rows = await supaFetch('GET', q)
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return
    let sent = 0
    for (const o of list) {
      const r = await sendRecoveryEmail(o)
      if (r && r.ok) sent++
      await new Promise(res => setTimeout(res, 250)) // pace leve
    }
    if (sent) console.log(`[recoveryCron] ✅ ${sent}/${list.length} e-mails de recuperação enviados`)
  } catch (e) { console.error('[recoveryCron] erro:', e.message) }
}

function startRecoveryEmailCron() {
  if (_timer) return
  const on = String(process.env.RECOVERY_EMAIL_ENABLED || '') === 'true'
  console.log(`[recoveryCron] ${on ? '✅ LIGADO' : '⏸️ desligado (RECOVERY_EMAIL_ENABLED!=true)'} — intervalo ${INTERVAL_MIN}min, janela ${MIN_AGE_MIN}-${MAX_AGE_MIN}min`)
  setTimeout(() => { runRecoveryOnce(); _timer = setInterval(runRecoveryOnce, Math.max(1, INTERVAL_MIN) * 60000) }, 30000)
}

module.exports = { runRecoveryOnce, startRecoveryEmailCron }
