// Kwai Event API (server-side / S2S) — envio garantido do evento de compra
// (EVENT_PURCHASE) direto do nosso servidor pro Kwai, à prova de adblock/iOS.
// Endpoint validado 30/07/2026 (respondeu {"result":1}).
//
// ⚠️ clickid = TOKEN REAL DE CLIQUE emitido pelo Kwai (internamente chamado de
// `callback`). PROVADO 07/ago/2026 testando a API: token real → {"result":1};
// valor inventado por nós → {"result":10005,"callback字段不合法"} (REJEITADO).
// Logo o clickid NÃO pode ser gerado — TEM que vir da URL do clique (macro
// `callback` do Kwai) e ser salvo em orders.kwai_clickid. (O suporte do Kwai disse
// "é random, não precisa na URL" — está ERRADO, a API deles desmente.) SEM clickid
// real o evento não atribui e é recusado → pulamos. Meta/TikTok casam por
// email/telefone; Kwai não.
//
// Config por env (Coolify lembranca-api):
//   KWAI_EVENTS_TOKEN = access token do Event API (SEGREDO)
//   KWAI_PIXEL_ID     = id do pixel (default: o pixel atual abaixo)

const axios = require('axios');

const ENDPOINT = 'https://www.adsnebula.com/log/common/api';
const DEFAULT_PIXEL = '317839512073323';

// Core genérico. order: { id, kwai_clickid, payment_amount, plan }.
// eventName ex: 'EVENT_PURCHASE' (compra), 'EVENT_ADD_TO_CART' (gerou PIX).
async function sendKwaiEvent(order, eventName) {
  const token = process.env.KWAI_EVENTS_TOKEN;
  const pixelId = process.env.KWAI_PIXEL_ID || DEFAULT_PIXEL;
  if (!token) return { skipped: 'no_token' };
  if (!order || !order.id) return { skipped: 'no_order' };

  const clickid = order.kwai_clickid;
  if (!clickid) return { skipped: 'no_clickid' }; // sem clickid REAL o Kwai recusa (10005) — pula

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
    event_name: eventName,
    is_attributed: 1, // sempre com clickid real aqui (senão já pulou acima)
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
    const ok = r.data && (r.data.result === 1 || r.data.result === '1'); // {"result":1} = aceito
    if (ok) console.log(`[kwaiCapi] ✅ ${eventName} enviado order`, order.id, 'value', value);
    else console.warn(`[kwaiCapi] ⚠️ resposta inesperada (${eventName}) order`, order.id, ':', JSON.stringify(r.data));
    return { ok, response: r.data };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error(`[kwaiCapi] ❌ erro (${eventName}) order`, order.id, ':', detail);
    return { ok: false, error: String(e.message) };
  }
}

// Compra (pós-pagamento confirmado, nos webhooks).
const sendPurchaseToKwai = (order) => sendKwaiEvent(order, 'EVENT_PURCHASE');
// Add-to-cart (cliente clicou pra gerar PIX) — evento de otimização de campanha.
const sendAddToCartToKwai = (order) => sendKwaiEvent(order, 'EVENT_ADD_TO_CART');

module.exports = { sendPurchaseToKwai, sendAddToCartToKwai, sendKwaiEvent };
