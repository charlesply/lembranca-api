// ═══════════════════════════════════════════════════════════════════════════
// RECUPERAÇÃO ATIVA por e-mail — DRIP DE 4 TOQUES (20/jul).
//
// Toques (âncora = quando a prévia ficou pronta, gravada em recovery_email_sent_at):
//   1) ready — assim que a prévia fica pronta (imediato, qualquer horário)
//   2) t60   — 60 min depois (imediato, qualquer horário)
//   3) t1d   — ~24h depois, MESMO horário travado na janela 8h-21h BRT
//   4) t3d   — ~72h depois, idem janela — "último dia, prévia expira" (scarcity)
//
// Trilhas A/B: B (passinho) e C (elogio) — FIXA por pedido (recovery_email_variant,
// sorteada no toque 1, reusada nos demais). Copy varia por toque × trilha.
//
// Remetente MARKETING (bia@marketing.…) pra isolar reputação do transacional.
// Respeita email_opt_out + List-Unsubscribe. Para se pagar/opt-out (checado no cron).
// ═══════════════════════════════════════════════════════════════════════════
const axios = require('axios')
const { supaFetch } = require('./supabase')

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL_MKT = process.env.EMAIL_FROM_MKT || 'bia@marketing.lembrancacantada.com'
const FROM_NAME_MKT = process.env.EMAIL_FROM_MKT_NAME || 'Bia da Lembrança Cantada'
const REPLY_TO_MKT = process.env.EMAIL_REPLY_TO || 'bia@lembrancacantada.com'
const APP_URL = process.env.APP_URL || 'https://app.lembrancacantada.com'
const UNSUB_BASE = process.env.UNSUB_BASE_URL || 'https://suno-api-novo.bvph.uk'
const SRC = 'email_recuperacao'

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ── Trilhas ativas (A/B). Default B,C. Ajustável por env sem tocar no código. ──
const VARIANT_POOL = (() => {
  const raw = (process.env.RECOVERY_EMAIL_VARIANTS || 'B,C')
    .split(',').map(s => s.trim().toUpperCase()).filter(k => k === 'B' || k === 'C')
  return raw.length ? raw : ['B', 'C']
})()
function pickVariant() { return VARIANT_POOL[Math.floor(Math.random() * VARIANT_POOL.length)] }

// ── Ordem dos toques + coluna de idempotência de cada um ──
const TOUCH_ORDER = ['ready', 't60', 't1d', 't3d']
const TOUCH_COL = { ready: 'recovery_email_sent_at', t60: 'recovery_2_sent_at', t1d: 'recovery_3_sent_at', t3d: 'recovery_4_sent_at' }

// ── Conteúdo: CONTENT[touch][variant] = { subject(hon,nome), emoji, headline(hon), paras:[fn], cta } ──
// {p} = primeiro nome com vírgula na frente (", João") ou vazio.
const CONTENT = {
  ready: {
    B: {
      subject: (h) => `Prontinho! A prévia da ${h} ficou linda 💛`,
      emoji: '🎶', headline: (h) => `A prévia da <span style="color:#CC785C;">${esc(h)}</span> ficou pronta!`,
      paras: (h, p) => [
        `Oi${p}! Aqui é a Bia, da Lembrança Cantada 💛`,
        `Sua prévia da <strong>${esc(h)}</strong> ficou pronta — e ficou uma graça! Dá o play e escuta 🥰`,
        `Se curtir, faltou só um passinho: liberar a <strong>versão completa</strong> — as duas músicas inteiras (a prévia é só um trechinho), em alta qualidade. A música fica sua pra sempre.`,
      ], cta: '🎧 Ouvir a prévia',
    },
    C: {
      subject: (h, n) => `${n || 'Ei'}, sua prévia da ${h} tá pronta — corre ouvir 🎶`,
      emoji: '🎧', headline: (h) => `Sua prévia da <span style="color:#CC785C;">${esc(h)}</span> ficou pronta!`,
      paras: (h, p) => [
        `Oi${p}! Corre ouvir — a prévia da <strong>${esc(h)}</strong> ficou linda 🥰`,
        `Aqui é a Bia 💛 Se você gostar, é só liberar a <strong>versão completa</strong> (as duas músicas inteiras, em alta qualidade) e ela é sua pra sempre.`,
      ], cta: '🎧 Ouvir agora',
    },
  },
  t60: {
    B: {
      subject: (h, n) => `${n || 'Oi'}, faltou só um passinho pra liberar a música da ${h}`,
      emoji: '💛', headline: (h) => `Faltou só um passinho`,
      paras: (h, p) => [
        `Oi${p}! Vi que você ouviu a prévia da <strong>${esc(h)}</strong> mas ainda não liberou a completa.`,
        `É rapidinho 💛 Assim que o PIX cai, libera <strong>na hora</strong> — as duas versões inteiras, em alta qualidade.`,
      ], cta: '🎧 Liberar minha música',
    },
    C: {
      subject: (h) => `Ouviu de novo? A prévia da ${h} ficou uma graça 🥰`,
      emoji: '🥰', headline: (h) => `A prévia da <span style="color:#CC785C;">${esc(h)}</span> ficou uma graça, né?`,
      paras: (h, p) => [
        `E aí${p}, ouviu de novo? 😄`,
        `Se curtiu, libera a <strong>versão completa</strong> e já manda pra <strong>${esc(h)}</strong>. Cai o PIX, libera na hora 💛`,
      ], cta: '💛 Liberar a completa',
    },
  },
  t1d: {
    B: {
      subject: (h) => `Sua música pra ${h} ainda tá prontinha aqui 💛`,
      emoji: '💛', headline: (h) => `Sua música pra <span style="color:#CC785C;">${esc(h)}</span> ainda tá aqui`,
      paras: (h, p) => [
        `Oi${p}! Passando só pra lembrar: a prévia da <strong>${esc(h)}</strong> continua prontinha te esperando.`,
        `Seria uma pena deixar essa música parada — a <strong>${esc(h)}</strong> vai amar 🥰 É só um passinho pra liberar a versão completa.`,
      ], cta: '🎧 Ouvir e liberar',
    },
    C: {
      subject: (h, n) => `${n || 'Ei'}, a ${h} vai amar essa música 💛`,
      emoji: '💛', headline: (h) => `A <span style="color:#CC785C;">${esc(h)}</span> vai amar essa música`,
      paras: (h, p) => [
        `Imagina a carinha da <strong>${esc(h)}</strong> ouvindo uma música feita só pra ela 🥰`,
        `Oi${p}! Sua prévia ainda tá aqui — é só liberar a <strong>versão completa</strong> e viver esse momento 💛`,
      ], cta: '💛 Liberar agora',
    },
  },
  t3d: {
    B: {
      subject: (h) => `Último dia: a prévia da ${h} expira hoje 💛`,
      emoji: '⏳', headline: (h) => `Último dia da prévia da <span style="color:#CC785C;">${esc(h)}</span>`,
      paras: (h, p) => [
        `Oi${p}! Um aviso com carinho: pra liberar espaço no nosso sistema, a prévia da <strong>${esc(h)}</strong> <strong>vai expirar hoje</strong>.`,
        `Se quiser guardar a música completa pra sempre, é só finalizar antes do fim do dia 💛 Não deixa ela ir embora!`,
      ], cta: '🎧 Liberar antes que expire',
    },
    C: {
      subject: (h, n) => `${n || 'Ei'}, hoje é o último dia da prévia da ${h} 🎶`,
      emoji: '⏳', headline: (h) => `Hoje é o último dia 🎶`,
      paras: (h, p) => [
        `Oi${p}! Sua prévia da <strong>${esc(h)}</strong> <strong>expira hoje</strong> (a gente precisa liberar espaço no sistema).`,
        `Seria uma pena perder essa música — libera a <strong>versão completa</strong> e ela fica sua pra sempre 💛`,
      ], cta: '💛 Garantir minha música',
    },
  },
}

function renderHtml({ emoji, headlineHtml, parasHtml, cta, honoree, ctaUrl, unsubUrl }) {
  const paras = parasHtml.map(p =>
    `<p style="margin:0 0 12px; font-size:15px; color:#6b5a4d; line-height:1.6;">${p}</p>`).join('\n        ')
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Sua música na Lembrança Cantada</title></head>
<body style="margin:0; padding:0; background:#fef9f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#2b1d14;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fef9f5; padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="500" style="max-width:500px; background:#fffaf6; border-radius:18px; border:1px solid #f3e5d8;">
      <tr><td style="padding:30px 34px 6px; text-align:center;"><div style="font-size:12px; letter-spacing:.08em; color:#CC785C; font-weight:700;">LEMBRANÇA CANTADA</div></td></tr>
      <tr><td style="padding:6px 34px 4px; text-align:center;"><div style="font-size:40px; line-height:1;">${emoji}</div></td></tr>
      <tr><td style="padding:6px 34px 0; text-align:center;">
        <h1 style="margin:0; font-size:23px; font-weight:700; color:#2b1d14; line-height:1.3;">${headlineHtml}</h1>
      </td></tr>
      <tr><td style="padding:16px 34px 0;">
        ${paras}
      </td></tr>
      <tr><td style="padding:20px 34px 8px; text-align:center;">
        <a href="${esc(ctaUrl)}" style="display:inline-block; background:#CC785C; color:#ffffff !important; text-decoration:none; padding:15px 34px; border-radius:12px; font-weight:700; font-size:16px;">${cta}</a>
      </td></tr>
      <tr><td style="padding:4px 34px 0; text-align:center;">
        <p style="margin:0; font-size:13px; color:#a08d7e; line-height:1.5;">Assim que o pagamento cair, libera na hora e você já pode mandar pra ${esc(honoree)}.</p>
      </td></tr>
      <tr><td style="padding:22px 34px 26px; text-align:center; border-top:1px solid #f3e5d8;">
        <p style="margin:0 0 8px; font-size:12px; color:#a08d7e;">Qualquer dúvida, é só responder este e-mail 💛<br/><strong style="color:#8a7969;">Lembrança Cantada</strong></p>
        <p style="margin:0; font-size:11px; color:#c3b4a6;">Não quer mais esses lembretes? <a href="${esc(unsubUrl)}" style="color:#c3b4a6;">descadastre-se aqui</a>.</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`
}

function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, '') }
function renderText({ headline, paras, cta, ctaUrl, honoree, unsubUrl }) {
  return [
    stripTags(headline), '',
    ...paras.map(stripTags), '',
    `${cta}: ${ctaUrl}`, '',
    `Assim que o pagamento cair, libera na hora.`, '',
    `Descadastrar: ${unsubUrl}`,
  ].join('\n')
}

// Envia UM toque do drip. opts: { touch: 'ready'|'t60'|'t1d'|'t3d', variant?, test? }
// Retorna { ok, variant, touch, id, skipped? }.
async function sendRecoveryEmail(order, opts = {}) {
  const touch = opts.touch || 'ready'
  if (!TOUCH_COL[touch]) return { ok: false, skipped: 'bad_touch' }
  if (!RESEND_API_KEY) return { ok: false, skipped: 'no_key' }
  if (!order || !order.id || !order.customer_email) return { ok: false, skipped: 'no_email' }
  if (order.email_opt_out) return { ok: false, skipped: 'opt_out' }

  // Trilha: sorteia no toque 1, reusa a gravada nos demais.
  const variant = opts.variant || order.recovery_email_variant || pickVariant()
  const cell = (CONTENT[touch] && CONTENT[touch][variant]) || CONTENT[touch].B
  const honoree = order.honoree_name || 'sua pessoa especial'
  const nome = (order.customer_name || '').split(/\s+/)[0] || ''
  const p = nome ? `, ${esc(nome)}` : ''

  const subject = cell.subject(honoree, nome)
  const headlineHtml = cell.headline(honoree)
  const parasHtml = cell.paras(honoree, p)
  const unsubUrl = `${UNSUB_BASE}/unsub/${order.id}?c=${SRC}`
  const ctaUrl = `${APP_URL}/finalizar/${order.id}?src=${SRC}&touch=${touch}&v=${variant}&utm_source=${SRC}&utm_medium=email&utm_campaign=recuperacao_${touch}`

  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${FROM_NAME_MKT} <${FROM_EMAIL_MKT}>`,
      to: [order.customer_email],
      reply_to: REPLY_TO_MKT,
      subject,
      html: renderHtml({ emoji: cell.emoji, headlineHtml, parasHtml, cta: cell.cta, honoree, ctaUrl, unsubUrl }),
      text: renderText({ headline: headlineHtml, paras: parasHtml, cta: cell.cta, ctaUrl, honoree, unsubUrl }),
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>, <mailto:bia@lembrancacantada.com?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: [{ name: 'kind', value: 'recovery' }, { name: 'touch', value: touch }, { name: 'variant', value: variant }],
    }, { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 })

    if (!opts.test) {
      const patch = { [TOUCH_COL[touch]]: new Date().toISOString() }
      if (touch === 'ready') { patch.recovery_email_sent = true; patch.recovery_email_variant = variant }
      // guarda o id do Resend p/ o webhook email.clicked marcar email_clicked_at
      // (atribuição de conversão SÓ por clique, igual o SMS).
      if (r.data?.id) patch.recovery_email_resend_id = r.data.id
      await supaFetch('PATCH', `orders?id=eq.${order.id}`, patch)
    }
    console.log(`[recoveryEmail] ✅ order=${order.id} toque=${touch} trilha=${variant} to=${order.customer_email}`)
    return { ok: true, variant, touch, id: r.data?.id }
  } catch (e) {
    console.error('[recoveryEmail] ❌ order', order.id, 'toque', touch, ':', JSON.stringify(e.response?.data || e.message).slice(0, 300))
    return { ok: false, error: e.response?.data || e.message }
  }
}

// Renderiza SEM enviar (pra revisão/preview). Retorna { subject, html, text }.
function renderPreview(order, opts = {}) {
  const touch = opts.touch || 'ready'
  const variant = opts.variant || 'B'
  const cell = (CONTENT[touch] && CONTENT[touch][variant]) || CONTENT.ready.B
  const honoree = order.honoree_name || 'sua pessoa especial'
  const nome = (order.customer_name || '').split(/\s+/)[0] || ''
  const p = nome ? `, ${esc(nome)}` : ''
  const headlineHtml = cell.headline(honoree)
  const parasHtml = cell.paras(honoree, p)
  const unsubUrl = `${UNSUB_BASE}/unsub/${order.id || 'x'}?c=${SRC}`
  const ctaUrl = `${APP_URL}/finalizar/${order.id || 'x'}?src=${SRC}&touch=${touch}&v=${variant}`
  return {
    subject: cell.subject(honoree, nome),
    html: renderHtml({ emoji: cell.emoji, headlineHtml, parasHtml, cta: cell.cta, honoree, ctaUrl, unsubUrl }),
    text: renderText({ headline: headlineHtml, paras: parasHtml, cta: cell.cta, ctaUrl, honoree, unsubUrl }),
  }
}

module.exports = { sendRecoveryEmail, renderPreview, TOUCH_ORDER, TOUCH_COL, CONTENT }
