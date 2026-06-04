// MONITOR DO SITE — manda um resumo do funil (leads / prévias / vendas) pro WhatsApp do ADMIN
// a cada N minutos. Lê tudo do Supabase (orders), não mexe no site. Gated por SITE_MONITOR_ENABLED.
const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
const ADMIN_PHONE = process.env.MONITOR_ADMIN_PHONE || '5511920188319';
const ENABLED = process.env.SITE_MONITOR_ENABLED !== 'false';
let _timer = null;

async function _sendText(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
    { number: String(phone).replace(/\D/g, ''), text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
}

// início do dia no horário de Brasília (UTC-3), em ISO UTC
function _brazilTodayStartISO() {
  const nowBR = new Date(Date.now() - 3 * 3600 * 1000);
  nowBR.setUTCHours(0, 0, 0, 0);
  return new Date(nowBR.getTime() + 3 * 3600 * 1000).toISOString();
}

async function _count(filter) {
  try { const r = await supaFetch('GET', `orders?${filter}&select=id`); return Array.isArray(r) ? r.length : 0; }
  catch (e) { return 0; }
}
async function _sales(sinceISO) {
  try {
    const r = await supaFetch('GET', `orders?paid_at=gte.${sinceISO}&select=amount_cents,payment_amount`);
    const arr = Array.isArray(r) ? r : [];
    let total = 0;
    for (const o of arr) total += (o.amount_cents ? o.amount_cents / 100 : (Number(o.payment_amount) || 0));
    return { n: arr.length, total };
  } catch (e) { return { n: 0, total: 0 }; }
}

const _fmt = (v) => Number(v || 0).toFixed(2).replace('.', ',');

async function runSiteMonitorOnce(trigger = 'cron') {
  const since30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const todayStart = _brazilTodayStartISO();
  const leads30 = await _count(`created_at=gte.${since30}`);
  const prev30 = await _count(`preview_sent_at=gte.${since30}`);
  const s30 = await _sales(since30);
  const leadsT = await _count(`created_at=gte.${todayStart}`);
  const prevT = await _count(`preview_sent_at=gte.${todayStart}`);
  const sT = await _sales(todayStart);

  const msg = `📊 *Site — últimos 30 min*\n` +
    `👥 Leads: ${leads30}\n` +
    `🎵 Prévias: ${prev30}\n` +
    `💰 Vendas: ${s30.n}${s30.n ? ` (R$ ${_fmt(s30.total)})` : ''}\n\n` +
    `📈 *Hoje*: ${leadsT} leads · ${prevT} prévias · ${sT.n} vendas (R$ ${_fmt(sT.total)})`;

  // no cron, pula período sem nenhum movimento (não floodar o admin com zeros)
  if (trigger === 'cron' && (leads30 + prev30 + s30.n) === 0) {
    return { ok: true, skipped: true, leads30, prev30, sales30: s30.n };
  }
  try { await _sendText(ADMIN_PHONE, msg); } catch (e) { console.error('[siteMonitor] envio falhou:', e.message); }
  return { ok: true, sent: true, leads30, prev30, sales30: s30.n, hoje: { leadsT, prevT, salesT: sT.n }, msg };
}

function startSiteMonitorCron() {
  if (!ENABLED || _timer) return;
  const min = Math.max(5, parseInt(process.env.SITE_MONITOR_INTERVAL_MIN || '30', 10));
  console.log(`[siteMonitor] ✅ cron ON — resumo do funil a cada ${min}min pro admin (${ADMIN_PHONE})`);
  setTimeout(async () => {
    try { await _sendText(ADMIN_PHONE, `✅ *Monitor do site LIGADO* 📊\nTe aviso a cada ${min} min quando tiver movimento no funil (leads, prévias, vendas).`); } catch (e) {}
    _timer = setInterval(() => { runSiteMonitorOnce('cron').catch(() => {}); }, min * 60 * 1000);
  }, 20000);
}

module.exports = { runSiteMonitorOnce, startSiteMonitorCron };
