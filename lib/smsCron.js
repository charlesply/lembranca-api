// lib/smsCron — envio de SMS "modo PRODUÇÃO" (forward-only, CAPADO) via TeleSegNet.
//
// Ideia: NÃO dispara pro backlog antigo. Vai enviando pros pedidos NOVOS conforme
// entram — recuperação (não pagou) + entrega (pagou) — com TETO rígido pro teste.
//
// 🔒 3 travas de segurança (todas obrigatórias):
//   1. SMS_CRON_ENABLED=true  — liga o cron automático (senão no-op)
//   2. SMS_CRON_SINCE=<ISO>   — SÓ pedidos com created_at/paid_at >= isso
//      (anti-blast + "só daqui pra frente"). SEM isso NÃO envia nada.
//   3. Teto: SMS_RECOVERY_CAP (300) / SMS_DELIVERY_CAP (50) — conta o já-enviado
//      por tipo e nunca ultrapassa. Máximo absoluto = 300 + 50 = 350.
//
// Marca sms_sent_at + sms_type no pedido (não reenvia + alimenta o relatório).
// Link é o /s/{id} rastreável (marca sms_clicked_at no clique).
const { supaFetch } = require('./supabase');
const { sendSmsBatch, buildRecoveryMsg, buildDeliveryMsg } = require('./sms');

const ENABLED = () => String(process.env.SMS_CRON_ENABLED || '') === 'true';
const SINCE = () => (process.env.SMS_CRON_SINCE || '').trim();
const RECOVERY_CAP = () => parseInt(process.env.SMS_RECOVERY_CAP || '300', 10);
const DELIVERY_CAP = () => parseInt(process.env.SMS_DELIVERY_CAP || '50', 10);
const PER_RUN = () => parseInt(process.env.SMS_PER_RUN || '40', 10);
const INTERVAL_MIN = parseInt(process.env.SMS_INTERVAL_MIN || '3', 10);
const REC_MIN_AGE = () => parseInt(process.env.SMS_RECOVERY_MIN_AGE_MIN || '30', 10); // deixa pagar natural primeiro
const DEL_MIN_AGE = () => parseInt(process.env.SMS_DELIVERY_MIN_AGE_MIN || '5', 10);  // e-mail de entrega vai antes

const isoAgo = (min) => new Date(Date.now() - min * 60000).toISOString();

async function countSent(type) {
  const rows = await supaFetch('GET', `orders?sms_type=eq.${type}&sms_sent_at=not.is.null&select=id`);
  return Array.isArray(rows) ? rows.length : 0;
}
async function markSent(ids, type) {
  if (!ids.length) return;
  const list = ids.join(',');
  await supaFetch('PATCH', `orders?id=in.(${list})`, { sms_sent_at: new Date().toISOString(), sms_type: type });
}

async function runRecovery(budget) {
  if (budget <= 0) return { sent: 0, cap: true };
  const limit = Math.min(budget, PER_RUN());
  const rows = await supaFetch('GET',
    `orders?status=eq.preview_sent&paid_at=is.null&sms_sent_at=is.null&email_opt_out=eq.false`
    + `&phone=not.is.null&preview_audio_url=not.is.null`
    + `&created_at=lte.${isoAgo(REC_MIN_AGE())}&created_at=gte.${SINCE()}`
    + `&select=id,customer_name,phone&order=created_at.asc&limit=${limit}`) || [];
  const stamp = Date.now().toString(36);
  const msgs = [], ids = [];
  for (const o of rows) { const m = buildRecoveryMsg(o, stamp); if (m) { msgs.push(m); ids.push(o.id); } }
  if (!msgs.length) return { sent: 0 };
  const r = await sendSmsBatch(msgs);
  if (r.ok) { await markSent(ids, 'recovery'); console.log(`[smsCron] recuperação: ${ids.length} enviados`); return { sent: ids.length }; }
  console.warn('[smsCron] recuperação falhou:', JSON.stringify(r).slice(0, 200));
  return { sent: 0, error: r };
}

async function runDelivery(budget) {
  if (budget <= 0) return { sent: 0, cap: true };
  const limit = Math.min(budget, PER_RUN());
  const rows = await supaFetch('GET',
    `orders?paid_at=not.is.null&sms_sent_at=is.null&phone=not.is.null&original_audio_url=not.is.null`
    + `&paid_at=lte.${isoAgo(DEL_MIN_AGE())}&paid_at=gte.${SINCE()}`
    + `&select=id,customer_name,phone&order=paid_at.asc&limit=${limit}`) || [];
  const stamp = Date.now().toString(36);
  const msgs = [], ids = [];
  for (const o of rows) { const m = buildDeliveryMsg(o, stamp); if (m) { msgs.push(m); ids.push(o.id); } }
  if (!msgs.length) return { sent: 0 };
  const r = await sendSmsBatch(msgs);
  if (r.ok) { await markSent(ids, 'delivery'); console.log(`[smsCron] entrega: ${ids.length} enviados`); return { sent: ids.length }; }
  console.warn('[smsCron] entrega falhou:', JSON.stringify(r).slice(0, 200));
  return { sent: 0, error: r };
}

async function runSmsOnce(mode) {
  if (mode !== 'manual' && !ENABLED()) return { skipped: 'disabled' };
  if (!process.env.SMS_ACCOUNT || !process.env.SMS_CODE) return { skipped: 'no_creds' };
  if (!SINCE()) return { skipped: 'no_since (anti-blast: setar SMS_CRON_SINCE)' }; // 🔒 trava dura
  try {
    const [recSent, delSent] = await Promise.all([countSent('recovery'), countSent('delivery')]);
    const rec = await runRecovery(RECOVERY_CAP() - recSent);
    const del = await runDelivery(DELIVERY_CAP() - delSent);
    const out = {
      ok: true,
      recovery: { jaEnviados: recSent, teto: RECOVERY_CAP(), enviadosAgora: rec.sent, atingiuTeto: !!rec.cap },
      delivery: { jaEnviados: delSent, teto: DELIVERY_CAP(), enviadosAgora: del.sent, atingiuTeto: !!del.cap },
    };
    if (rec.sent || del.sent) console.log('[smsCron]', JSON.stringify(out));
    return out;
  } catch (e) { console.error('[smsCron] erro:', e.message); return { ok: false, error: e.message }; }
}

let _timer = null;
function startSmsCron() {
  if (_timer) return;
  console.log(`[smsCron] ${ENABLED() ? '✅ LIGADO' : '⏸️ desligado (SMS_CRON_ENABLED!=true)'} — teto recup ${RECOVERY_CAP()}/entrega ${DELIVERY_CAP()}, since=${SINCE() || '(nenhum → não envia)'}, intervalo ${INTERVAL_MIN}min`);
  setTimeout(() => { runSmsOnce(); _timer = setInterval(runSmsOnce, Math.max(1, INTERVAL_MIN) * 60000); }, 35000);
}

module.exports = { runSmsOnce, startSmsCron };
