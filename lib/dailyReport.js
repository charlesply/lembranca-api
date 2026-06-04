// RELATÓRIO COMPLETO 2x/dia (a cada 12h, alinhado à meia-noite de Brasília).
// Conta o DIA INTEIRO de Brasília (00h→00h). Cobre site + WhatsApp: leads, prévias geradas/
// enviadas, músicas entregues, vídeos brinde (gerados/enviados), vendas, upsells e problemas
// (pedidos travados). Termina com um MENU DE AÇÕES pro admin responder.
// Read-only no Supabase. Gated por DAILY_REPORT_ENABLED=true.
// Teste: GET /api/daily_report_run?send=1 (envia) ou sem send (só retorna o texto).
const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
const ADMIN_PHONE = process.env.MONITOR_ADMIN_PHONE || '351912589669';
const ENABLED = String(process.env.DAILY_REPORT_ENABLED).toLowerCase() === 'true';
let _timer = null;

const _fmt = (v) => Number(v || 0).toFixed(2).replace('.', ',');

// janela do relatório no fuso de Brasília (UTC-3).
// Por padrão mostra HOJE (00h→agora). Na virada (00h BR, hora < 1) ou com opts.closeYesterday=true,
// fecha o DIA ANTERIOR inteiro (00h→24h) — assim o relatório da meia-noite resume o dia que TERMINOU.
function _brLabel(utcMs) {
  const d = new Date(utcMs - 3 * 3600 * 1000);
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
function _reportWindow(opts = {}) {
  const now = Date.now();
  const nowBR = new Date(now - 3 * 3600 * 1000);
  const brHour = nowBR.getUTCHours();
  let closeYesterday = opts.closeYesterday;
  if (closeYesterday === undefined) closeYesterday = brHour < 1; // roda na virada (00h BR) → fecha ontem
  const startTodayBR = new Date(nowBR); startTodayBR.setUTCHours(0, 0, 0, 0);
  const startTodayUTC = startTodayBR.getTime() + 3 * 3600 * 1000;
  if (closeYesterday) {
    const startYestUTC = startTodayUTC - 24 * 3600 * 1000;
    return {
      since: new Date(startYestUTC).toISOString(), until: new Date(startTodayUTC).toISOString(),
      dateLabel: _brLabel(startYestUTC), rangeLabel: 'fechado · 00h→24h', closed: true,
    };
  }
  const hh = String(brHour).padStart(2, '0') + 'h' + String(nowBR.getUTCMinutes()).padStart(2, '0');
  return {
    since: new Date(startTodayUTC).toISOString(), until: null,
    dateLabel: _brLabel(now), rangeLabel: '00h→' + hh, closed: false,
  };
}
// filtro de range no PostgREST (limite superior só no dia fechado)
function _rng(field, w) {
  return `${field}=gte.${w.since}` + (w.until ? `&${field}=lt.${w.until}` : '');
}

async function _count(filter) {
  try { const r = await supaFetch('GET', `orders?${filter}&select=id`); return Array.isArray(r) ? r.length : 0; }
  catch (e) { return 0; }
}

async function buildReport(opts = {}) {
  const w = _reportWindow(opts);
  // 1) pedidos CRIADOS na janela — leads, canal, prévias geradas, travados
  const novos = await supaFetch('GET',
    `orders?${_rng('created_at', w)}&select=honoree_name,status,client_contacted_at,bill_id,preview_audio_url,full_audio_urls,video_brinde_url,error_message&limit=1000`) || [];
  const arr = Array.isArray(novos) ? novos : [];
  let leads = arr.length, wa = 0, site = 0, geradas = 0, videoGer = 0;
  const travados = [];
  for (const o of arr) {
    if (o.client_contacted_at) wa++; else site++;
    if (o.preview_audio_url || (o.full_audio_urls && o.full_audio_urls.length)) geradas++;
    if (o.video_brinde_url) videoGer++;
    const st = (o.status || '').toLowerCase();
    if (['failed', 'awaiting_retry'].includes(st) && !o.preview_audio_url) travados.push(o.honoree_name || '?');
  }
  // 2) métricas por EVENTO (timestamp na janela)
  const enviadas = await _count(_rng('preview_sent_at', w));
  const entregues = await _count(_rng('delivered_at', w));
  const videoSent = await _count(_rng('video_brinde_sent_at', w));
  const upsells = await _count(_rng('video_upsell_paid_at', w));
  // 3) vendas (paid_at) + faturamento — SEPARADO por canal (WhatsApp = contatou a Bia · Site = não)
  let vendasWA = 0, vendasSite = 0, fatWA = 0, fatSite = 0;
  try {
    const pg = await supaFetch('GET', `orders?${_rng('paid_at', w)}&select=amount_cents,client_contacted_at`) || [];
    for (const o of (Array.isArray(pg) ? pg : [])) {
      const val = o.amount_cents ? o.amount_cents / 100 : 19.90;
      if (o.client_contacted_at) { vendasWA++; fatWA += val; } else { vendasSite++; fatSite += val; }
    }
  } catch (e) {}
  const vendasN = vendasWA + vendasSite;
  const fat = fatWA + fatSite;
  const conv = leads > 0 ? Math.round((vendasN / leads) * 100) : 0;

  const linhaTrav = travados.length
    ? `\n\n⚠️ *${travados.length} pedido(s) travado(s):* ${travados.slice(0, 5).join(', ')}${travados.length > 5 ? '…' : ''}\n_(responde *TRAVADOS* que eu re-disparo)_`
    : '\n\n✅ Nenhum pedido travado.';

  const msg =
    `📊 *RELATÓRIO ${w.closed ? 'DO DIA' : 'PARCIAL'} — ${w.dateLabel}* (${w.rangeLabel}, Brasília)\n` +
    `━━━━━━━━━━━━━━\n` +
    `👥 *Leads:* ${leads}  _(📱 WhatsApp ${wa} · 🌐 Site ${site})_\n` +
    `🎧 *Prévias geradas:* ${geradas}\n` +
    `📤 *Prévias enviadas:* ${enviadas}\n` +
    `💳 *Vendas:* ${vendasN}  —  *R$ ${_fmt(fat)}*\n` +
    `   _📱 WhatsApp: ${vendasWA} (R$ ${_fmt(fatWA)})  ·  🌐 Site: ${vendasSite} (R$ ${_fmt(fatSite)})_\n` +
    `📦 *Músicas entregues:* ${entregues}\n` +
    `🎬 *Vídeos brinde:* ${videoGer} gerados · ${videoSent} enviados\n` +
    `✨ *Upsells (vídeo c/ foto):* ${upsells}\n` +
    `📈 *Conversão:* ${conv}% _(vendas/leads)_` +
    linhaTrav +
    `\n━━━━━━━━━━━━━━\n` +
    `🛠️ *AÇÕES* — é só responder aqui:\n` +
    `• *TRAVADOS* — ver/re-disparar pedidos presos\n` +
    `• *VENDAS* — detalhe das vendas de hoje\n` +
    `• *PENDENTES* — prévias/vídeos na fila\n` +
    `• *SUNO* — status do Suno/cookie\n` +
    `• *RELATORIO* — gerar esse resumo agora`;

  return { msg, leads, wa, site, geradas, enviadas, vendasN, vendasWA, vendasSite, fat, fatWA, fatSite, entregues, videoGer, videoSent, upsells, conv, travados: travados.length };
}

async function _sendText(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
    { number: String(phone).replace(/\D/g, ''), text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
}

async function runDailyReportOnce(opts = {}) {
  try {
    const r = await buildReport(opts);
    if (opts.send !== false) {
      try { await _sendText(ADMIN_PHONE, r.msg); } catch (e) { console.error('[dailyReport] envio falhou:', e.message); }
    }
    return r;
  } catch (e) { console.error('[dailyReport] erro:', e.message); return { error: e.message }; }
}

// próximo slot UTC 03:00 (00h BR) ou 15:00 (12h BR)
function _msUntilNextSlot() {
  const now = Date.now();
  const base = new Date(now);
  let cands = [];
  for (const day of [0, 1]) {
    for (const h of [3, 15]) {
      const t = new Date(base); t.setUTCDate(base.getUTCDate() + day); t.setUTCHours(h, 0, 0, 0);
      cands.push(t.getTime());
    }
  }
  cands = cands.filter((t) => t > now).sort((a, b) => a - b);
  return cands[0] - now;
}

function startDailyReportCron() {
  if (_timer) return;
  if (!ENABLED) { console.log('[dailyReport] desabilitado (DAILY_REPORT_ENABLED != true)'); return; }
  const wait = _msUntilNextSlot();
  console.log(`[dailyReport] ✅ cron ON — 1º relatório em ${Math.round(wait / 60000)}min, depois a cada 12h (00h/12h Brasília)`);
  setTimeout(() => {
    runDailyReportOnce().catch(() => {});
    _timer = setInterval(() => runDailyReportOnce().catch(() => {}), 12 * 3600 * 1000);
  }, wait);
}

module.exports = { buildReport, runDailyReportOnce, startDailyReportCron };
