// TikTok Events API (server-side) — envio garantido do evento de compra
// (CompletePayment) direto do nosso servidor, à prova de adblock/iOS/ITP.
// Dedup com o pixel client-side via `event_id` compartilhado (purchase_{orderId}),
// espelhando exatamente o padrão do metaCapi.js.
//
// Config por env (Coolify lembranca-api):
//   TIKTOK_EVENTS_TOKEN  = access token gerado no Events Manager (SEGREDO)
//   TIKTOK_PIXEL_ID      = id do pixel (default: o pixel atual abaixo)

const axios = require('axios');
const crypto = require('crypto');

const API_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const DEFAULT_PIXEL = 'D9JUHKBC77UD7F80FBCG';

// TikTok exige SHA-256 de email/telefone/external_id normalizados (lower+trim).
function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '').trim().toLowerCase()).digest('hex');
}
function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}
// Telefone em E.164 (+55…) ANTES do hash — TikTok casa melhor assim.
function e164(phoneDigits) {
  if (!phoneDigits) return '';
  const d = phoneDigits.startsWith('55') ? phoneDigits : '55' + phoneDigits;
  return '+' + d;
}

// order: { id, customer_email, phone, payment_amount, plan, paid_at,
//          client_ip, client_user_agent, ttclid?, ttp? }
async function sendPurchaseToTiktok(order) {
  const token = process.env.TIKTOK_EVENTS_TOKEN;
  const pixelId = process.env.TIKTOK_PIXEL_ID || DEFAULT_PIXEL;
  if (!token) { return { skipped: 'no_token' }; }
  if (!order || !order.id) { return { skipped: 'no_order' }; }

  const emailRaw = String(order.customer_email || '').trim().toLowerCase();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw);
  const phoneDigits = digitsOnly(order.phone);

  const user = {};
  if (emailValid) user.email = sha256(emailRaw);
  if (phoneDigits.length >= 10) user.phone = sha256(e164(phoneDigits));
  user.external_id = sha256(order.id);
  if (order.client_ip) user.ip = order.client_ip;
  if (order.client_user_agent) user.user_agent = order.client_user_agent;
  if (order.ttclid) user.ttclid = order.ttclid; // click id do TikTok (se capturado)
  if (order.ttp) user.ttp = order.ttp;           // cookie _ttp (se capturado)

  const value = Number(order.payment_amount) || 0;

  // event_time = conversão REAL (paid_at), não o envio. TikTok aceita eventos
  // recentes; usar o horário real melhora atribuição e dedup. Fallback = agora.
  let eventTime = Math.floor(Date.now() / 1000);
  if (order.paid_at) {
    const t = Math.floor(new Date(order.paid_at).getTime() / 1000);
    if (Number.isFinite(t) && t > 0) eventTime = t;
  }

  const payload = {
    event_source: 'web',
    event_source_id: pixelId,
    data: [
      {
        event: 'CompletePayment',
        event_time: eventTime,
        event_id: `purchase_${order.id}`,
        user,
        properties: {
          currency: 'BRL',
          value,
          content_type: 'product',
          contents: [{ content_id: String(order.id), content_type: 'product', content_name: order.plan || 'musica' }],
        },
        page: { url: process.env.SITE_URL || 'https://app.lembrancacantada.com' },
      },
    ],
  };

  try {
    const r = await axios.post(API_URL, payload, {
      headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    // TikTok responde { code: 0, message: 'OK', ... } quando aceita.
    const ok = r.data && (r.data.code === 0 || r.data.code === '0');
    if (ok) {
      console.log('[tiktokCapi] ✅ CompletePayment enviado order', order.id, 'value', value);
    } else {
      console.warn('[tiktokCapi] ⚠️ resposta inesperada order', order.id, ':', JSON.stringify(r.data));
    }
    return { ok, response: r.data };
  } catch (e) {
    const detail = e.response?.data?.message || e.message;
    console.error('[tiktokCapi] ❌ erro order', order.id, ':', detail);
    return { ok: false, error: detail };
  }
}

module.exports = { sendPurchaseToTiktok };
