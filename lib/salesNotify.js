// Notificacao de venda — WhatsApp pessoal (Evolution) + Pushcut (push iPhone).
//
// Disparado pelo webhook AbacatePay (billing.paid) APOS marcar status=paid.
// Fire-and-forget — falha aqui nao bloqueia entrega.
//
// Envs:
//   SALES_NOTIFY_PHONE      → telefone pessoal do dono pra receber WhatsApp
//                             (formato: 5511992667376). Sem isso, WhatsApp pulado.
//   PUSHCUT_URL_BY_AMOUNT   → JSON {"19.90":"https://...","29.90":"https://...","47.90":"..."}
//                             Sem isso, Pushcut pulado.
//   EVO_URL/EVO_KEY/EVO_INSTANCE → reusa as envs ja existentes
const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
const EVO_KEY = process.env.EVO_KEY || '';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';

const SALES_PHONE = String(process.env.SALES_NOTIFY_PHONE || '').replace(/\D/g, '');

// Mapa valor -> URL do Pushcut, parseado 1x no boot.
let PUSHCUT_BY_AMOUNT = {};
try {
  PUSHCUT_BY_AMOUNT = JSON.parse(process.env.PUSHCUT_URL_BY_AMOUNT || '{}');
} catch (e) {
  console.error('[salesNotify] PUSHCUT_URL_BY_AMOUNT JSON invalido:', e.message);
}

const APP_URL = process.env.APP_URL || 'https://app.lembrancacantada.com';

const _fmtBRL = (v) => (Number(v) || 0).toFixed(2).replace('.', ',');
const _now = () => {
  // Brasilia time = UTC-3
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

async function _sendWhatsApp(text) {
  if (!SALES_PHONE) { console.log('[salesNotify] SALES_NOTIFY_PHONE nao configurado, pulando WhatsApp'); return; }
  if (!EVO_KEY) { console.log('[salesNotify] EVO_KEY ausente, pulando WhatsApp'); return; }
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
    { number: SALES_PHONE, text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
}

async function _firePushcut(amount) {
  const url = PUSHCUT_BY_AMOUNT[String(amount)] || PUSHCUT_BY_AMOUNT[_fmtBRL(amount)];
  if (!url) { console.log(`[salesNotify] sem Pushcut configurado pro valor ${amount}, pulando`); return; }
  await axios.post(url, {}, { timeout: 10000 });
  console.log(`[salesNotify] Pushcut disparado pra ${amount}: ${url.slice(0, 60)}...`);
}

// Notifica uma venda. Busca a order, monta mensagem, dispara WhatsApp + Pushcut.
async function notifySale(orderId) {
  try {
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,customer_name,customer_email,phone,honoree_name,relationship,plan,payment_amount,paid_at,fbp_pixel_id,utm_source,utm_campaign,utm_medium,utm_term,utm_content,src`);
    const o = Array.isArray(rows) && rows[0];
    if (!o) { console.warn(`[salesNotify] order ${orderId} nao encontrada`); return; }

    const amount = Number(o.payment_amount) || 0;
    const planLabel = o.plan === 'completa' ? 'completa (MP3 + video)' : (o.plan || 'musica');
    const utm_lines = [];
    if (o.src) utm_lines.push(`• src: ${o.src}`);
    if (o.utm_source) utm_lines.push(`• utm_source: ${o.utm_source}`);
    if (o.utm_campaign) utm_lines.push(`• utm_campaign: ${o.utm_campaign}`);
    if (o.utm_medium) utm_lines.push(`• utm_medium: ${o.utm_medium}`);
    if (o.utm_term) utm_lines.push(`• utm_term: ${o.utm_term}`);
    if (o.utm_content) utm_lines.push(`• utm_content: ${o.utm_content}`);
    if (o.fbp_pixel_id) utm_lines.push(`• fbp_pixel_id: ${o.fbp_pixel_id}`);

    const text =
      `💰 *NOVA VENDA — R$ ${_fmtBRL(amount)}*\n\n` +
      `👤 Cliente: ${o.customer_name || '-'}\n` +
      `📞 Fone: ${o.phone || '-'}\n` +
      `📧 Email: ${o.customer_email || '-'}\n` +
      `💝 Homenageado: ${o.honoree_name || '-'} (${o.relationship || '-'})\n` +
      `📦 Plano: ${planLabel}\n\n` +
      (utm_lines.length ? `🎯 Origem:\n${utm_lines.join('\n')}\n\n` : '🎯 Origem: (direto / sem UTM)\n\n') +
      `🔗 Order: ${APP_URL}/p/${o.id}\n\n` +
      `📅 ${_now()} BRT`;

    // Fire WhatsApp + Pushcut em paralelo, nao-blocking
    Promise.all([
      _sendWhatsApp(text).catch(e => console.error('[salesNotify] whatsapp erro:', e.message)),
      _firePushcut(_fmtBRL(amount)).catch(e => console.error('[salesNotify] pushcut erro:', e.message)),
    ]).catch(() => {});
    console.log(`[salesNotify] disparado pra order ${orderId} (R$ ${_fmtBRL(amount)})`);
  } catch (e) {
    console.error('[salesNotify] erro:', e.message);
  }
}

module.exports = { notifySale };
