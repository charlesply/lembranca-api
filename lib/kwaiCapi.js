// Kwai Event API (server-side / S2S) — envio garantido do evento de compra
// (EVENT_PURCHASE) direto do nosso servidor pro Kwai, à prova de adblock/iOS.
// Endpoint validado 30/07/2026 (respondeu {"result":1}).
//
// ⚠️ Kwai atribui a conversão pelo `clickid` (id do clique no anúncio, capturado
// da URL de entrada e salvo em orders.kwai_clickid). SEM clickid o evento não
// atribui — então pulamos (não faz sentido mandar). Diferente do Meta/TikTok que
// casam por email/telefone.
//
// Config por env (Coolify lembranca-api):
//   KWAI_EVENTS_TOKEN = access token do Event API (SEGREDO)
//   KWAI_PIXEL_ID     = id do pixel (default: o pixel atual abaixo)

const axios = require('axios');

const ENDPOINT = 'https://www.adsnebula.com/log/common/api';
const DEFAULT_PIXEL = '317839512073323';

// order: { id, kwai_clickid, payment_amount, plan }
async function sendPurchaseToKwai(order) {
  const token = process.env.KWAI_EVENTS_TOKEN;
  const pixelId = process.env.KWAI_PIXEL_ID || DEFAULT_PIXEL;
  if (!token) return { skipped: 'no_token' };
  if (!order || !order.id) return { skipped: 'no_order' };

  const clickid = order.kwai_clickid;
  if (!clickid) return { skipped: 'no_clickid' }; // sem clickid não atribui — pula

  const value = Number(order.payment_amount) || 0;
  // properties DEVE ser uma STRING JSON (não objeto) — exigência do Kwai.
  const properties = JSON.stringify({
    content_id: String(order.id),
    content_type: 'product',
    content_name: order.plan || 'musica',
  });

  const payload = {
    access_token: token,
    clickid,
    event_name: 'EVENT_PURCHASE',
    is_attributed: 1,
    mmpcode: 'PL',
    pixelId,
    pixelSdkVersion: '9.9.9',
    currency: 'BRL',
    value: value ? String(value) : undefined, // Kwai aceita value como string
    properties,
    trackFlag: false, // 🔴 PRODUÇÃO. true = só modo teste (Test Server Events).
  };

  try {
    const r = await axios.post(ENDPOINT, payload, {
      headers: { accept: 'application/json;charset=utf-8', 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    // Kwai responde {"result":1} quando aceita.
    const ok = r.data && (r.data.result === 1 || r.data.result === '1');
    if (ok) {
      console.log('[kwaiCapi] ✅ EVENT_PURCHASE enviado order', order.id, 'value', value);
    } else {
      console.warn('[kwaiCapi] ⚠️ resposta inesperada order', order.id, ':', JSON.stringify(r.data));
    }
    return { ok, response: r.data };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('[kwaiCapi] ❌ erro order', order.id, ':', detail);
    return { ok: false, error: String(e.message) };
  }
}

module.exports = { sendPurchaseToKwai };
