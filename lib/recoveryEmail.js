// ═══════════════════════════════════════════════════════════════════════════
// E-mail de RECUPERAÇÃO ATIVA — disparado 7 min após a prévia se o cliente não
// pagou. Voz da Bia (mesmo tom do funil do CRM): "sua prévia ficou linda, falta
// só liberar a completa". A/B de 3 assuntos + rastreio de origem/variante.
//
// Remetente MARKETING (bia@marketing.lembrancacantada.com) pra ISOLAR reputação
// do transacional (bia@lembrancacantada.com que entrega os pedidos pagos).
// Respeita email_opt_out + List-Unsubscribe (Gmail/Outlook 2024+ / LGPD).
// ═══════════════════════════════════════════════════════════════════════════
const axios = require('axios')
const { supaFetch } = require('./supabase')

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL_MKT = process.env.EMAIL_FROM_MKT || 'bia@marketing.lembrancacantada.com'
const FROM_NAME_MKT = process.env.EMAIL_FROM_MKT_NAME || 'Bia da Lembrança Cantada'
const REPLY_TO_MKT = process.env.EMAIL_REPLY_TO || 'bia@lembrancacantada.com'
const APP_URL = process.env.APP_URL || 'https://app.lembrancacantada.com'
// O handler /unsub fica no BACKEND (não no app/frontend) → aponta pro domínio da API.
const UNSUB_BASE = process.env.UNSUB_BASE_URL || 'https://suno-api-novo.bvph.uk'
const SRC = 'email_recuperacao'

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ── A/B: 3 assuntos aprovados pelo dono (variante sorteada por e-mail) ──
const VARIANTS = {
  A: (hon) => `Sua música pra ${hon} está quase pronta 🎶`,
  B: (hon) => `Faltou só um passinho pra liberar a música da ${hon} 💛`,
  C: (hon, nome) => `${nome || 'Ei'}, sua prévia ficou linda — vamos liberar a completa?`,
}
function pickVariant() { const k = ['A', 'B', 'C']; return k[Math.floor(Math.random() * k.length)] }

function renderHtml({ honoree, customerName, ctaUrl, unsubUrl }) {
  const greeting = customerName ? `Oi, ${esc(customerName.split(/\s+/)[0])}!` : 'Oi!'
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Sua música está quase pronta</title></head>
<body style="margin:0; padding:0; background:#fef9f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#2b1d14;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fef9f5; padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="500" style="max-width:500px; background:#fffaf6; border-radius:18px; border:1px solid #f3e5d8;">
      <tr><td style="padding:30px 34px 6px; text-align:center;"><div style="font-size:12px; letter-spacing:.08em; color:#CC785C; font-weight:700;">LEMBRANÇA CANTADA</div></td></tr>
      <tr><td style="padding:6px 34px 4px; text-align:center;"><div style="font-size:40px; line-height:1;">🎶</div></td></tr>
      <tr><td style="padding:6px 34px 0; text-align:center;">
        <h1 style="margin:0; font-size:23px; font-weight:700; color:#2b1d14; line-height:1.3;">Sua música pra <span style="color:#CC785C;">${esc(honoree)}</span> está quase pronta</h1>
      </td></tr>
      <tr><td style="padding:16px 34px 0;">
        <p style="margin:0 0 12px; font-size:15px; color:#6b5a4d; line-height:1.6;">${greeting} 💛 Aqui é a Bia, da Lembrança Cantada.</p>
        <p style="margin:0 0 12px; font-size:15px; color:#6b5a4d; line-height:1.6;">Vi que você criou a prévia da música pra <strong style="color:#57493d;">${esc(honoree)}</strong> — e ela ficou uma graça! 🥰</p>
        <p style="margin:0 0 4px; font-size:15px; color:#6b5a4d; line-height:1.6;">Faltou só um passinho: liberar a <strong style="color:#57493d;">versão completa</strong> — as duas versões inteiras, em alta qualidade e sem aquela voz por cima da prévia. A música fica sua pra sempre 💛</p>
      </td></tr>
      <tr><td style="padding:20px 34px 8px; text-align:center;">
        <a href="${esc(ctaUrl)}" style="display:inline-block; background:#CC785C; color:#ffffff !important; text-decoration:none; padding:15px 34px; border-radius:12px; font-weight:700; font-size:16px;">🎧 Ouvir a prévia e liberar</a>
      </td></tr>
      <tr><td style="padding:4px 34px 0; text-align:center;">
        <p style="margin:0; font-size:13px; color:#a08d7e; line-height:1.5;">Assim que o pagamento cair, libera na hora e você já pode mandar pra ${esc(honoree)}.</p>
      </td></tr>
      <tr><td style="padding:22px 34px 26px; text-align:center; border-top:1px solid #f3e5d8; margin-top:14px;">
        <p style="margin:0 0 8px; font-size:12px; color:#a08d7e;">Qualquer dúvida, é só responder este e-mail 💛<br/><strong style="color:#8a7969;">Lembrança Cantada</strong></p>
        <p style="margin:0; font-size:11px; color:#c3b4a6;">Não quer mais esses lembretes? <a href="${esc(unsubUrl)}" style="color:#c3b4a6;">descadastre-se aqui</a>.</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`
}

function renderText({ greetingName, honoree, ctaUrl, unsubUrl }) {
  return [
    greetingName ? `Oi, ${greetingName}!` : 'Oi!', '',
    `Aqui é a Bia, da Lembrança Cantada 💛`,
    `Vi que você criou a prévia da música pra ${honoree} — ficou linda!`,
    `Faltou só liberar a versão completa (as duas versões inteiras, em alta qualidade e sem a voz por cima).`,
    '', `🎧 Ouvir a prévia e liberar:`, ctaUrl, '',
    `Assim que o pagamento cair, libera na hora.`, '',
    `Descadastrar: ${unsubUrl}`,
  ].join('\n')
}

// Envia o e-mail de recuperação. Retorna { ok, variant, id, skipped? }.
async function sendRecoveryEmail(order, opts = {}) {
  if (!RESEND_API_KEY) return { ok: false, skipped: 'no_key' }
  if (!order || !order.id || !order.customer_email) return { ok: false, skipped: 'no_email' }
  if (order.email_opt_out) return { ok: false, skipped: 'opt_out' }
  if (order.recovery_email_sent) return { ok: false, skipped: 'already_sent' }

  const honoree = order.honoree_name || 'sua pessoa especial'
  const nome = (order.customer_name || '').split(/\s+/)[0] || ''
  const variant = opts.forceVariant || pickVariant()
  const subject = VARIANTS[variant](honoree, nome)
  const unsubUrl = `${UNSUB_BASE}/unsub/${order.id}?c=${SRC}`
  const ctaUrl = `${APP_URL}/finalizar/${order.id}?src=${SRC}&v=${variant}&utm_source=${SRC}&utm_medium=email&utm_campaign=recuperacao_previa`

  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${FROM_NAME_MKT} <${FROM_EMAIL_MKT}>`,
      to: [order.customer_email],
      reply_to: REPLY_TO_MKT,
      subject,
      html: renderHtml({ honoree, customerName: order.customer_name || '', ctaUrl, unsubUrl }),
      text: renderText({ greetingName: nome, honoree, ctaUrl, unsubUrl }),
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>, <mailto:bia@lembrancacantada.com?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: [{ name: 'kind', value: 'recovery' }, { name: 'variant', value: variant }],
    }, { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    // Marca enviado + variante (dedup + A/B tracking). Só se NÃO for teste.
    if (!opts.test) {
      await supaFetch('PATCH', `orders?id=eq.${order.id}`, {
        recovery_email_sent: true,
        recovery_email_sent_at: new Date().toISOString(),
        recovery_email_variant: variant,
      })
    }
    console.log(`[recoveryEmail] ✅ order=${order.id} variante=${variant} to=${order.customer_email}`)
    return { ok: true, variant, id: r.data?.id }
  } catch (e) {
    console.error('[recoveryEmail] ❌ order', order.id, ':', JSON.stringify(e.response?.data || e.message).slice(0, 300))
    return { ok: false, error: e.response?.data || e.message }
  }
}

module.exports = { sendRecoveryEmail, VARIANTS }
