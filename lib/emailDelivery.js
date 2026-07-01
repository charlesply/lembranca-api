// ═══════════════════════════════════════════════════════════════════════════
// Email transacional de entrega — quando cliente paga, dispara email com
// link pra /p/:id (player + download). NÃO anexa MP3/MP4 (vai pro spam).
//
// Stack: Resend (https://resend.com)
// Idempotência: orders.email_delivery_sent (boolean) + email_delivery_sent_at
//
// Disparado por:
//   1) Webhook AbacatePay imediatamente após PAID (caminho rápido)
//   2) Cron emailDeliveryMonitor (rede de segurança, varre paid sem email)
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios')
const { supaFetch } = require('./supabase')

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL = process.env.EMAIL_FROM || 'bia@lembrancacantada.com'
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Bia da Lembrança Cantada'
const REPLY_TO = process.env.EMAIL_REPLY_TO || FROM_EMAIL
const APP_URL = process.env.APP_URL || 'https://app.lembrancacantada.com'

// Escapa HTML pra evitar injection em template literals
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

// Template HTML completo. Inline CSS por compatibilidade com clientes de email
// (Gmail descarta <style> em alguns casos; Outlook é o pior). Cores da marca:
//   primária #CC785C (terracota)
//   fundo    #fef9f5 (creme)
//   texto    #2b1d14 (marrom escuro)
function renderHtml({ honoree, customerName, plan, deliveryUrl }) {
  const isCompleta = plan === 'completa'
  const greeting = customerName ? `Olá, ${esc(customerName.split(/\s+/)[0])}!` : 'Olá!'
  const planLabel = isCompleta ? '2 versões da música + vídeo com a letra' : '2 versões da música'

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Sua música está pronta!</title>
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
          <td style="padding:8px 32px 16px; text-align:center;">
            <h1 style="margin:0; font-size:26px; font-weight:700; line-height:1.25; color:#2b1d14;">
              Sua música para <span style="color:#CC785C;">${esc(honoree)}</span> está pronta!
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px; text-align:center;">
            <p style="margin:0; font-size:16px; color:#7a6354; line-height:1.5;">
              ${greeting} 💛<br/>
              Sua ${esc(planLabel)} já estão disponíveis pra ouvir, baixar e compartilhar.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px; text-align:center;">
            <a href="${esc(deliveryUrl)}"
               style="display:inline-block; background:#CC785C; color:#ffffff !important; text-decoration:none; padding:16px 36px; border-radius:12px; font-weight:700; font-size:16px; box-shadow:0 6px 16px rgba(204,120,92,0.25);">
              🎧 Ouvir e baixar a música
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <div style="background:#fdfaf6; border:1px solid #f6ede2; border-radius:14px; padding:20px;">
              <p style="margin:0 0 8px; font-size:14px; color:#7a6354; line-height:1.5;">
                💡 <strong>Salva esse e-mail!</strong> Você pode acessar sua música quando quiser, mesmo daqui a meses.
              </p>
              <p style="margin:0; font-size:13px; color:#a09080; line-height:1.5;">
                O link funciona em qualquer dispositivo — celular, computador, tablet.
              </p>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 8px; text-align:center;">
            <p style="margin:0; font-size:13px; color:#7a6354; line-height:1.5;">
              Quer fazer outra música? É só responder esse e-mail ou voltar em
              <a href="${esc(APP_URL)}" style="color:#CC785C; text-decoration:none;">app.lembrancacantada.com</a>
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
      <p style="margin:16px auto 0; max-width:560px; font-size:11px; color:#b5a89c; text-align:center; line-height:1.5;">
        Você está recebendo esse e-mail porque comprou uma música personalizada no Lembrança Cantada.
      </p>
    </td>
  </tr>
</table>
</body>
</html>`
}

// Texto plain pra clientes que bloqueiam HTML (mínimo).
function renderText({ honoree, customerName, plan, deliveryUrl }) {
  const isCompleta = plan === 'completa'
  const planLabel = isCompleta ? '2 versões da música + vídeo com a letra' : '2 versões da música'
  const greeting = customerName ? `Olá, ${customerName.split(/\s+/)[0]}!` : 'Olá!'
  return [
    `${greeting}`,
    ``,
    `Sua música personalizada para ${honoree} está pronta!`,
    `${planLabel} disponíveis pra ouvir, baixar e compartilhar.`,
    ``,
    `🎧 Ouvir e baixar agora:`,
    `${deliveryUrl}`,
    ``,
    `Salva esse e-mail — você pode acessar sua música quando quiser.`,
    ``,
    `Um abraço carinhoso,`,
    `Bia da Lembrança Cantada 💛`,
  ].join('\n')
}

// Envia o email via Resend API. Idempotente: respeita order.email_delivery_sent.
// Retorna { ok, skipped?, id?, error? }.
async function sendDeliveryEmail(order) {
  if (!RESEND_API_KEY) {
    console.warn('[emailDelivery] RESEND_API_KEY ausente — pulando envio')
    return { ok: false, skipped: 'no_key' }
  }
  if (!order || !order.id) return { ok: false, skipped: 'no_order' }
  if (!order.customer_email) return { ok: false, skipped: 'no_email' }
  if (order.email_delivery_sent) return { ok: false, skipped: 'already_sent' }
  // Só envia se tem URL pra entregar
  const hasMedia = order.original_audio_url
    || (Array.isArray(order.full_audio_urls) && order.full_audio_urls.length)
    || order.video_brinde_url
  if (!hasMedia) return { ok: false, skipped: 'no_media' }

  const deliveryUrl = `${APP_URL}/p/${order.id}`
  const subject = `🎵 Sua música para ${order.honoree_name || 'você'} está pronta!`

  const params = {
    honoree: order.honoree_name || 'você',
    customerName: order.customer_name || '',
    plan: order.plan || 'musica',
    deliveryUrl,
  }

  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [order.customer_email],
      reply_to: REPLY_TO,
      subject,
      html: renderHtml(params),
      text: renderText(params),
      tags: [
        { name: 'kind', value: 'delivery' },
        { name: 'plan', value: order.plan || 'musica' },
      ],
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    })
    const emailId = r.data?.id
    console.log('[emailDelivery] ✅ enviado order', order.id, 'to', order.customer_email, 'id', emailId)
    // Marca como enviado pra não duplicar
    await supaFetch('PATCH', `orders?id=eq.${order.id}`, {
      email_delivery_sent: true,
      email_delivery_sent_at: new Date().toISOString(),
      email_delivery_id: emailId || null,
    })
    return { ok: true, id: emailId }
  } catch (e) {
    const detail = e.response?.data || e.message
    console.error('[emailDelivery] ❌ erro order', order.id, ':', JSON.stringify(detail).slice(0, 300))
    return { ok: false, error: detail }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// E-mail da NOVA música (self-edit): o cliente ajustou a própria música no
// painel e a nova versão ficou pronta. Copy diferente (não é a 1ª entrega) e
// NÃO usa o flag email_delivery_sent (esse é da entrega original). Idempotência
// fica por conta do step do Inngest (roda 1x por regeneração).
function renderEditHtml({ honoree, customerName, plan, deliveryUrl }) {
  const isCompleta = plan === 'completa'
  const greeting = customerName ? `Olá, ${esc(customerName.split(/\s+/)[0])}!` : 'Olá!'
  const planLabel = isCompleta ? '2 novas versões + um novo vídeo com a letra' : '2 novas versões'
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Sua nova música está pronta!</title></head>
<body style="margin:0; padding:0; background:#fef9f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#2b1d14;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fef9f5; padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px; background:#ffffff; border-radius:20px; border:1px solid #f3e5d8; box-shadow:0 12px 40px rgba(204,120,92,0.08);">
      <tr><td style="padding:40px 32px 8px; text-align:center;"><div style="font-size:48px; line-height:1;">✨🎶</div></td></tr>
      <tr><td style="padding:8px 32px 16px; text-align:center;">
        <h1 style="margin:0; font-size:26px; font-weight:700; line-height:1.25; color:#2b1d14;">Sua nova música para <span style="color:#CC785C;">${esc(honoree)}</span> ficou pronta!</h1>
      </td></tr>
      <tr><td style="padding:0 32px 24px; text-align:center;">
        <p style="margin:0; font-size:16px; color:#7a6354; line-height:1.5;">${greeting} 💛<br/>A gente criou as suas <strong>${esc(planLabel)}</strong> com o ajuste que você pediu. As versões anteriores continuam salvas junto — é só ouvir e escolher a favorita!</p>
      </td></tr>
      <tr><td style="padding:0 32px 32px; text-align:center;">
        <a href="${esc(deliveryUrl)}" style="display:inline-block; background:#CC785C; color:#ffffff !important; text-decoration:none; padding:16px 36px; border-radius:12px; font-weight:700; font-size:16px; box-shadow:0 6px 16px rgba(204,120,92,0.25);">🎧 Ouvir minhas músicas</a>
      </td></tr>
      <tr><td style="padding:0 32px 24px;">
        <div style="background:#fdfaf6; border:1px solid #f6ede2; border-radius:14px; padding:20px;">
          <p style="margin:0; font-size:14px; color:#7a6354; line-height:1.5;">💡 <strong>No painel você tem tudo:</strong> as 2 versões originais e as 2 novas, prontas pra baixar e compartilhar.</p>
        </div>
      </td></tr>
      <tr><td style="padding:24px 32px 32px; text-align:center; border-top:1px solid #f3e5d8;">
        <p style="margin:0; font-size:13px; color:#a09080; line-height:1.5;"><strong>Lembrança Cantada</strong> · Feito com carinho 💛</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`
}

function renderEditText({ honoree, customerName, plan, deliveryUrl }) {
  const isCompleta = plan === 'completa'
  const planLabel = isCompleta ? '2 novas versões + novo vídeo com a letra' : '2 novas versões'
  const greeting = customerName ? `Olá, ${customerName.split(/\s+/)[0]}!` : 'Olá!'
  return [
    `${greeting}`, ``,
    `Sua NOVA música para ${honoree} ficou pronta!`,
    `${planLabel} com o ajuste que você pediu — as versões anteriores continuam salvas junto.`,
    ``, `🎧 Ouvir minhas músicas:`, `${deliveryUrl}`, ``,
    `Um abraço carinhoso,`, `Bia da Lembrança Cantada 💛`,
  ].join('\n')
}

async function sendEditReadyEmail(order) {
  if (!RESEND_API_KEY) { console.warn('[emailDelivery/edit] RESEND_API_KEY ausente'); return { ok: false, skipped: 'no_key' } }
  if (!order || !order.id) return { ok: false, skipped: 'no_order' }
  if (!order.customer_email) return { ok: false, skipped: 'no_email' }
  const deliveryUrl = `${APP_URL}/p/${order.id}`
  const params = {
    honoree: order.honoree_name || 'você',
    customerName: order.customer_name || '',
    plan: order.plan || 'musica',
    deliveryUrl,
  }
  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [order.customer_email],
      reply_to: REPLY_TO,
      subject: `✨ Sua nova música para ${order.honoree_name || 'você'} ficou pronta!`,
      html: renderEditHtml(params),
      text: renderEditText(params),
      tags: [{ name: 'kind', value: 'edit-ready' }, { name: 'plan', value: order.plan || 'musica' }],
    }, { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    console.log('[emailDelivery/edit] ✅ enviado order', order.id, 'to', order.customer_email, 'id', r.data?.id)
    return { ok: true, id: r.data?.id }
  } catch (e) {
    console.error('[emailDelivery/edit] ❌ erro order', order.id, ':', JSON.stringify(e.response?.data || e.message).slice(0, 300))
    return { ok: false, error: e.response?.data || e.message }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// E-mail "🎬 seu vídeo está pronto" — pra vídeo que ATRASOU (cliente pagou
// completa, recebeu a música, mas o vídeo só ficou pronto depois — ex: os que
// falharam no AssemblyAI). Disparado 1x pelo _finalizeVideo do brindeVideo.
function renderVideoReadyHtml({ honoree, customerName, deliveryUrl }) {
  const greeting = customerName ? `Olá, ${esc(customerName.split(/\s+/)[0])}!` : 'Olá!'
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Seu vídeo está pronto!</title></head>
<body style="margin:0; padding:0; background:#fef9f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#2b1d14;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fef9f5; padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px; background:#ffffff; border-radius:20px; border:1px solid #f3e5d8; box-shadow:0 12px 40px rgba(204,120,92,0.08);">
      <tr><td style="padding:40px 32px 8px; text-align:center;"><div style="font-size:48px; line-height:1;">🎬</div></td></tr>
      <tr><td style="padding:8px 32px 16px; text-align:center;">
        <h1 style="margin:0; font-size:26px; font-weight:700; line-height:1.25; color:#2b1d14;">O vídeo da música para <span style="color:#CC785C;">${esc(honoree)}</span> ficou pronto!</h1>
      </td></tr>
      <tr><td style="padding:0 32px 24px; text-align:center;">
        <p style="margin:0; font-size:16px; color:#7a6354; line-height:1.5;">${greeting} 💛<br/>Desculpa a espera! O <strong>vídeo com a letra</strong> da sua música já está disponível pra assistir, baixar e compartilhar.</p>
      </td></tr>
      <tr><td style="padding:0 32px 32px; text-align:center;">
        <a href="${esc(deliveryUrl)}" style="display:inline-block; background:#CC785C; color:#ffffff !important; text-decoration:none; padding:16px 36px; border-radius:12px; font-weight:700; font-size:16px; box-shadow:0 6px 16px rgba(204,120,92,0.25);">🎬 Assistir meu vídeo</a>
      </td></tr>
      <tr><td style="padding:24px 32px 32px; text-align:center; border-top:1px solid #f3e5d8;">
        <p style="margin:0; font-size:13px; color:#a09080; line-height:1.5;"><strong>Lembrança Cantada</strong> · Feito com carinho 💛</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`
}

async function sendVideoReadyEmail(order) {
  if (!RESEND_API_KEY) return { ok: false, skipped: 'no_key' }
  if (!order || !order.id || !order.customer_email) return { ok: false, skipped: 'no_email' }
  const deliveryUrl = `${APP_URL}/p/${order.id}`
  const params = { honoree: order.honoree_name || 'você', customerName: order.customer_name || '', deliveryUrl }
  const text = [
    params.customerName ? `Olá, ${order.customer_name.split(/\s+/)[0]}!` : 'Olá!', '',
    `Desculpa a espera! O vídeo com a letra da música para ${params.honoree} já está pronto.`,
    '', `🎬 Assistir agora:`, deliveryUrl, '',
    `Um abraço carinhoso,`, `Bia da Lembrança Cantada 💛`,
  ].join('\n')
  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [order.customer_email],
      reply_to: REPLY_TO,
      subject: `🎬 O vídeo da música para ${order.honoree_name || 'você'} está pronto!`,
      html: renderVideoReadyHtml(params),
      text,
      tags: [{ name: 'kind', value: 'video-ready' }],
    }, { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    console.log('[emailDelivery/video] ✅ enviado order', order.id, 'to', order.customer_email, 'id', r.data?.id)
    return { ok: true, id: r.data?.id }
  } catch (e) {
    console.error('[emailDelivery/video] ❌ erro order', order.id, ':', JSON.stringify(e.response?.data || e.message).slice(0, 300))
    return { ok: false, error: e.response?.data || e.message }
  }
}

module.exports = { sendDeliveryEmail, sendEditReadyEmail, sendVideoReadyEmail, renderHtml, renderText }
