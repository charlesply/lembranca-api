// ═══════════════════════════════════════════════════════════════════════════
// Email MARKETING de recuperação — campanha "última chance".
// Disparado em massa pra leads que abandonaram a prévia nas últimas 48h.
//
// Stack: Resend (https://resend.com) — subdomínio marketing.lembrancacantada.com
// Dedup: promo_campaigns(order_id, campaign_name)  → mesma tabela do whatsapp.
//
// Diferenças vs emailDelivery (transacional):
//   • From: bia@marketing.lembrancacantada.com  (subdomínio isolado p/ reputação)
//   • List-Unsubscribe header (Gmail/Outlook 2024+ exige)
//   • Footer LGPD com link de unsubscribe
//   • Tag Resend: kind=promo, campaign=<slug>
//   • CTA → /promo/:id (página dedicada com countdown + checkout)
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios')
const { supaFetch } = require('./supabase')

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL_MKT = process.env.EMAIL_FROM_MKT || 'bia@marketing.lembrancacantada.com'
const FROM_NAME_MKT = process.env.EMAIL_FROM_MKT_NAME || 'Bia da Lembrança Cantada'
const REPLY_TO_MKT = process.env.EMAIL_REPLY_TO || 'bia@lembrancacantada.com'
const APP_URL = process.env.APP_URL || 'https://app.lembrancacantada.com'

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

// URL com UTMs (acoplado ao CTA + ao link "página exclusiva")
function withUtm(url, campaign) {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}utm_source=email&utm_medium=marketing&utm_campaign=${encodeURIComponent(campaign)}`
}

function renderHtml({ honoree, customerName, promoUrl, unsubUrl, campaignSlug }) {
  const greeting = customerName ? `Olá, ${esc(customerName.split(/\s+/)[0])}!` : 'Olá!'
  const ctaUrl = withUtm(promoUrl, campaignSlug)
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Sua música para ${esc(honoree)} está esperando</title>
</head>
<body style="margin:0; padding:0; background:#fef9f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#2b1d14;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fef9f5; padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px; background:#ffffff; border-radius:20px; border:1px solid #f3e5d8; box-shadow:0 12px 40px rgba(204,120,92,0.08);">

        <tr>
          <td style="padding:40px 32px 8px; text-align:center;">
            <div style="font-size:48px; line-height:1;">🎵</div>
          </td>
        </tr>

        <tr>
          <td style="padding:8px 32px 8px; text-align:center;">
            <div style="display:inline-block; background:#fff4ec; color:#CC785C; padding:6px 14px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:0.3px; text-transform:uppercase;">
              ⏰ Oferta especial · só hoje
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 32px 12px; text-align:center;">
            <h1 style="margin:0; font-size:26px; font-weight:700; line-height:1.25; color:#2b1d14;">
              Sua música para <span style="color:#CC785C;">${esc(honoree)}</span> ficou linda 💛
            </h1>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 24px; text-align:center;">
            <p style="margin:0; font-size:16px; color:#7a6354; line-height:1.55;">
              ${greeting} 💛<br/>
              Sua prévia está pronta há um tempinho aqui te esperando — preparei uma condição especial pra você liberar a música hoje.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 24px;">
            <div style="background:#fff7f1; border:2px solid #f0d8c4; border-radius:16px; padding:22px; text-align:center;">
              <div style="font-size:13px; color:#a08673; text-transform:uppercase; letter-spacing:0.5px; font-weight:600; margin-bottom:8px;">
                Hoje, com desconto especial
              </div>
              <div style="font-size:15px; color:#a09080; text-decoration:line-through; margin-bottom:4px;">
                De R$ 29,90
              </div>
              <div style="font-size:38px; font-weight:800; color:#CC785C; line-height:1.1; margin-bottom:8px;">
                R$ 19,90
              </div>
              <div style="font-size:14px; color:#5a4a3e; line-height:1.5;">
                🎵 As <strong>2 versões completas</strong> da música<br/>
                🎬 <strong>+ vídeo lyric</strong> com a letra passando — <em>grátis hoje</em>
              </div>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 28px; text-align:center;">
            <a href="${esc(ctaUrl)}"
               style="display:inline-block; background:#CC785C; color:#ffffff !important; text-decoration:none; padding:18px 38px; border-radius:14px; font-weight:800; font-size:17px; box-shadow:0 8px 20px rgba(204,120,92,0.32); letter-spacing:0.3px;">
              🔓 Liberar minha música agora
            </a>
            <div style="margin-top:12px; font-size:12px; color:#a09080;">
              Pagamento por PIX · libera na hora
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 24px;">
            <div style="background:#fdfaf6; border:1px solid #f6ede2; border-radius:14px; padding:18px;">
              <p style="margin:0 0 6px; font-size:14px; color:#7a6354; line-height:1.5;">
                💡 <strong>Por que é só hoje?</strong>
              </p>
              <p style="margin:0; font-size:13px; color:#a09080; line-height:1.55;">
                O vídeo lyric (que normalmente vem só no plano R$29,90) está incluso de cortesia nesse e-mail. Amanhã o preço volta ao normal.
              </p>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 8px; text-align:center;">
            <p style="margin:0; font-size:13px; color:#7a6354; line-height:1.5;">
              Qualquer dúvida, é só responder esse e-mail 💛
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 32px 32px; text-align:center; border-top:1px solid #f3e5d8;">
            <p style="margin:0; font-size:13px; color:#a09080; line-height:1.5;">
              <strong>Lembrança Cantada</strong> · Feito com carinho 💛
            </p>
          </td>
        </tr>

      </table>

      <p style="margin:16px auto 0; max-width:560px; font-size:11px; color:#b5a89c; text-align:center; line-height:1.6;">
        Você está recebendo esse e-mail porque criou uma música personalizada na Lembrança Cantada.<br/>
        Se não quer mais receber ofertas, <a href="${esc(unsubUrl)}" style="color:#b5a89c; text-decoration:underline;">descadastre-se aqui</a>.<br/>
        Lupelius Digital LTDA · CNPJ 42.920.135/0001-15
      </p>

    </td>
  </tr>
</table>
</body>
</html>`
}

function renderText({ honoree, customerName, promoUrl, unsubUrl, campaignSlug }) {
  const greeting = customerName ? `Olá, ${customerName.split(/\s+/)[0]}!` : 'Olá!'
  const ctaUrl = withUtm(promoUrl, campaignSlug)
  return [
    greeting,
    '',
    `Sua música personalizada para ${honoree} está pronta aqui te esperando 💛`,
    '',
    'Preparei uma condição especial pra você liberar hoje:',
    '',
    '🎵 As 2 versões completas da música',
    '🎬 + vídeo lyric com a letra passando — GRÁTIS hoje',
    '',
    'De R$ 29,90 por R$ 19,90 (apenas hoje).',
    '',
    `🔓 Liberar agora: ${ctaUrl}`,
    '',
    'Pagamento por PIX · libera na hora.',
    '',
    'Um abraço carinhoso,',
    'Bia da Lembrança Cantada 💛',
    '',
    '---',
    `Se não quer mais receber ofertas: ${unsubUrl}`,
    'Lupelius Digital LTDA · CNPJ 42.920.135/0001-15',
  ].join('\n')
}

// Envia 1 email. Dedup via promo_campaigns(order_id, campaign_name).
// Retorna { ok, skipped?, id?, error? }.
async function sendPromoEmail(order, opts = {}) {
  const campaignSlug = opts.campaignSlug || 'promo_recovery_jun26'
  if (!RESEND_API_KEY) return { ok: false, skipped: 'no_key' }
  if (!order || !order.id) return { ok: false, skipped: 'no_order' }
  if (!order.customer_email) return { ok: false, skipped: 'no_email' }

  // dedup: já recebeu essa campanha por email? (campanha pode ter rodado por whatsapp antes)
  const sent = await supaFetch('GET',
    `promo_campaigns?order_id=eq.${order.id}&campaign_name=eq.${campaignSlug}&email_sent_at=not.is.null&select=id&limit=1`)
  if (Array.isArray(sent) && sent.length) return { ok: false, skipped: 'already_sent' }

  const promoUrl = `${APP_URL}/promo/${order.id}`
  const unsubUrl = `${APP_URL}/unsub/${order.id}?c=${encodeURIComponent(campaignSlug)}`
  // Subject sem palavras-trigger de spam (sem R$, sem "oferta", sem "grátis").
  // Quebra padrão: nome do HOMENAGEADO primeiro (em vez do cliente).
  // Aprovado pelo dono em 15/jun.
  const honoree = order.honoree_name || 'sua pessoa especial'
  const subject = `Falta só liberar — a música pra ${honoree} está pronta`

  const params = {
    honoree: order.honoree_name || 'você',
    customerName: order.customer_name || '',
    promoUrl,
    unsubUrl,
    campaignSlug,
  }

  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${FROM_NAME_MKT} <${FROM_EMAIL_MKT}>`,
      to: [order.customer_email],
      reply_to: REPLY_TO_MKT,
      subject,
      html: renderHtml(params),
      text: renderText(params),
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>, <mailto:bia@lembrancacantada.com?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: [
        { name: 'kind', value: 'promo' },
        { name: 'campaign', value: campaignSlug },
      ],
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    })
    const emailId = r.data?.id
    console.log('[promoEmail] ✅ enviado order', order.id, 'to', order.customer_email, 'id', emailId)
    // grava em promo_campaigns. Schema separa por canal:
    //   email_sent_at  → carimbo do envio
    //   email_status   → resend email_id (pra correlacionar com webhook delivery/bounce)
    //   template_key   → identifica a copy/template usada
    await supaFetch('POST', 'promo_campaigns', {
      order_id: order.id,
      campaign_name: campaignSlug,
      template_key: 'promo_email_v1',
      email_sent_at: new Date().toISOString(),
      email_status: emailId || 'sent',
    })
    return { ok: true, id: emailId }
  } catch (e) {
    const detail = e.response?.data || e.message
    console.error('[promoEmail] ❌ erro order', order.id, ':', JSON.stringify(detail).slice(0, 300))
    return { ok: false, error: detail }
  }
}

module.exports = { sendPromoEmail, renderHtml, renderText }
