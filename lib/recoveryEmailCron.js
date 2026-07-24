// Cron da RECUPERAÇÃO ATIVA — DRIP DE 4 TOQUES (20/jul).
//   ready — prévia pronta (imediato, qualquer hora)
//   t60   — âncora + 60min (qualquer hora)
//   t1d   — âncora + 24h, MESMO horário travado em [8h,21h] BRT
//   t3d   — âncora + 72h, idem
// Âncora = recovery_email_sent_at (setado no toque ready).
// DESLIGADO por padrão — só roda com RECOVERY_EMAIL_ENABLED=true.
const { supaFetch } = require('./supabase')
const { sendRecoveryEmail } = require('./recoveryEmail')

const PER_RUN = parseInt(process.env.RECOVERY_PER_RUN || '60', 10)
// 🔒 ANTI-BLAST: toques 2/3/4 só p/ pedidos cuja âncora (recovery_email_sent_at) é
// >= este ISO. Ao LIGAR o drip, setar = agora → o backlog que já recebeu o e-mail
// antigo (único) NÃO leva os toques novos; só quem entra no drip daqui pra frente.
const DRIP_SINCE = (process.env.RECOVERY_DRIP_SINCE || '').trim()
const _sinceClause = DRIP_SINCE ? `&recovery_email_sent_at=gte.${DRIP_SINCE}` : ''
// Quais toques estão LIGADOS (csv). Ex: 'ready,t60' desliga o 1dia e o 3dias
// sem mexer no código. Default = todos os 4.
const TOUCHES_ON = new Set(
  (process.env.RECOVERY_TOUCHES || 'ready,t60,t1d,t3d').split(',').map(s => s.trim()).filter(Boolean)
)
const INTERVAL_MIN = parseInt(process.env.RECOVERY_INTERVAL_MIN || '2', 10)
const READY_MAX_AGE_MIN = parseInt(process.env.RECOVERY_READY_MAX_AGE_MIN || '360', 10) // toque 1 só p/ prévias recentes (evita blast do backlog ao ligar)
const H = 3600000, M = 60000
let _timer = null

// BRT = UTC-3 fixo (Brasil sem horário de verão desde 2019).
function brtHour(ms) { return new Date(ms - 3 * H).getUTCHours() }
function inWindow(ms) { const h = brtHour(ms); return h >= 8 && h <= 21 }
// Retorna o ms de envio: âncora+addMs, travado no MESMO dia BRT entre 08:00 e 21:00.
function clampDue(anchorMs, addMs) {
  const b = new Date(anchorMs + addMs - 3 * H) // getters UTC = relógio de parede BRT
  let mins = b.getUTCHours() * 60 + b.getUTCMinutes()
  if (mins < 480) mins = 480; else if (mins > 1260) mins = 1260 // [08:00, 21:00]
  b.setUTCHours(Math.floor(mins / 60), mins % 60, 0, 0)
  return b.getTime() + 3 * H
}

const COLS = 'id,honoree_name,customer_name,customer_email,email_opt_out,recovery_email_variant,recovery_email_sent_at'

async function _fetch(q) { const r = await supaFetch('GET', q); return Array.isArray(r) ? r : [] }
async function _send(list, touch) {
  let sent = 0
  for (const o of list) {
    const r = await sendRecoveryEmail(o, { touch })
    if (r && r.ok) sent++
    await new Promise(res => setTimeout(res, 250))
  }
  return sent
}

async function runRecoveryOnce() {
  if (String(process.env.RECOVERY_EMAIL_ENABLED || '') !== 'true') return
  try {
    const now = Date.now()
    const base = `paid_at=is.null&email_opt_out=eq.false&customer_email=not.is.null`
    let total = 0

    // ── TOQUE 1: prévia pronta (imediato, qualquer hora) ──
    if (TOUCHES_ON.has('ready')) {
      const lo = new Date(now - READY_MAX_AGE_MIN * M).toISOString()
      const q = `orders?${base}&recovery_email_sent=eq.false&preview_audio_url=not.is.null`
        + `&created_at=gte.${lo}&select=${COLS}&order=created_at.asc&limit=${PER_RUN}`
      total += await _send(await _fetch(q), 'ready')
    }

    // ── TOQUE 2: âncora + 60min (qualquer hora) ──
    if (TOUCHES_ON.has('t60')) {
      const cut = new Date(now - 60 * M).toISOString()
      const q = `orders?${base}&recovery_email_sent=eq.true&recovery_2_sent_at=is.null`
        + `&recovery_email_sent_at=lte.${cut}${_sinceClause}&select=${COLS}&order=recovery_email_sent_at.asc&limit=${PER_RUN}`
      total += await _send(await _fetch(q), 't60')
    }

    // ── TOQUE 3: âncora + 24h, janela 8-21h ──
    if (TOUCHES_ON.has('t1d') && inWindow(now)) {
      const hi = new Date(now - 21 * H).toISOString()   // prefiltro folgado (clamp pode adiantar até ~3h)
      const lo = new Date(now - 5 * 24 * H).toISOString()
      const gteLo = DRIP_SINCE && DRIP_SINCE > lo ? DRIP_SINCE : lo
      const q = `orders?${base}&recovery_email_sent=eq.true&recovery_3_sent_at=is.null`
        + `&recovery_email_sent_at=lte.${hi}&recovery_email_sent_at=gte.${gteLo}&select=${COLS}&order=recovery_email_sent_at.asc&limit=${PER_RUN}`
      const due = (await _fetch(q)).filter(o => {
        const a = Date.parse(o.recovery_email_sent_at); return a && now >= clampDue(a, 24 * H)
      })
      total += await _send(due, 't1d')
    }

    // ── TOQUE 4: âncora + 72h, janela 8-21h — "último dia" ──
    if (TOUCHES_ON.has('t3d') && inWindow(now)) {
      const hi = new Date(now - 69 * H).toISOString()
      const lo = new Date(now - 7 * 24 * H).toISOString()
      const gteLo = DRIP_SINCE && DRIP_SINCE > lo ? DRIP_SINCE : lo
      const q = `orders?${base}&recovery_email_sent=eq.true&recovery_4_sent_at=is.null`
        + `&recovery_email_sent_at=lte.${hi}&recovery_email_sent_at=gte.${gteLo}&select=${COLS}&order=recovery_email_sent_at.asc&limit=${PER_RUN}`
      const due = (await _fetch(q)).filter(o => {
        const a = Date.parse(o.recovery_email_sent_at); return a && now >= clampDue(a, 72 * H)
      })
      total += await _send(due, 't3d')
    }

    if (total) console.log(`[recoveryCron] ✅ ${total} e-mails de recuperação enviados (drip)`)
  } catch (e) { console.error('[recoveryCron] erro:', e.message) }
}

function startRecoveryEmailCron() {
  if (_timer) return
  const on = String(process.env.RECOVERY_EMAIL_ENABLED || '') === 'true'
  console.log(`[recoveryCron] ${on ? '✅ LIGADO' : '⏸️ desligado (RECOVERY_EMAIL_ENABLED!=true)'} — drip 4 toques, intervalo ${INTERVAL_MIN}min`)
  setTimeout(() => { runRecoveryOnce(); _timer = setInterval(runRecoveryOnce, Math.max(1, INTERVAL_MIN) * 60000) }, 30000)
}

module.exports = { runRecoveryOnce, startRecoveryEmailCron, clampDue, inWindow }
