// FUNIL DE LEADS — mantém orders.lead_stage automaticamente, DERIVANDO dos campos que o
// n8n e o backend já escrevem (status, paid_at, preview_sent_at, funnel_events). NÃO toca no
// n8n — só lê e classifica. Assim o marketing segmenta por estágio (promo/retenção/recompra).
//
// Estágios (funil, um por vez): em_coleta -> criar_musica -> aguardando_aprovacao ->
//   aguardando_pagamento -> pago -> concluido ; + desinteressado (prévia +48h sem pagar)
//   ; + travado (geração falhou/presa — lead que pediu música e nunca recebeu).
// Gated por LEAD_STAGE_ENABLED=true. PATCH por eq. (in.() quebra via axios).
const { supaFetch } = require('./supabase');

let _timer = null;
let _running = false;

// telefones de teste — nunca viram recorrente/vip
const TEST_PHONES = new Set(['11915391862', '5511915391862', '11915301862', '5511915301862',
  '5511999999999', '351912589669']);
// tags que ESTE cron gerencia (as outras, manuais, sao preservadas)
const AUTO_TAGS = ['recorrente', 'vip', 'upsell_pago'];
const _digits = (p) => String(p || '').replace(/\D/g, '');

// é compra concluída? (delivered ou pago)
function _ehCompra(o) {
  return o.status === 'delivered' || !!o.paid_at;
}

// tags automáticas pra ESTE pedido, dado o nº de compras do telefone
function _autoTags(o, comprasDoTelefone) {
  const t = [];
  const tel = _digits(o.phone);
  if (tel && !TEST_PHONES.has(tel)) {
    if (comprasDoTelefone >= 3) t.push('vip');
    if (comprasDoTelefone >= 2) t.push('recorrente');
  }
  if (o.video_upsell_status === 'upsell_delivered' || o.video_upsell_paid_at) t.push('upsell_pago');
  return t;
}

// mescla: preserva tags manuais (fora de AUTO_TAGS) + aplica as automáticas. Retorna null se já igual.
function _mergeTags(existing, auto) {
  const cur = Array.isArray(existing) ? existing : [];
  const manuais = cur.filter((t) => !AUTO_TAGS.includes(t));
  const next = Array.from(new Set([...manuais, ...auto])).sort();
  const same = next.length === cur.length && next.every((t) => cur.includes(t));
  return same ? null : next;
}

function _ageH(ts, nowMs) {
  if (!ts) return 0;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return 0;
  return (nowMs - t) / 3600000;
}

// Deriva o estágio do pedido a partir do que já existe no banco.
function deriveStage(o, psOid, psPhone, nowMs) {
  if (o.status === 'delivered') return 'concluido';
  if (o.paid_at) return 'pago';
  if (o.preview_sent_at) {
    if (_ageH(o.preview_sent_at, nowMs) > 48) return 'desinteressado';
    return (psOid.has(o.id) || psPhone.has(o.phone)) ? 'aguardando_pagamento' : 'aguardando_aprovacao';
  }
  if (o.status === 'generating' || o.status === 'awaiting_retry') {
    return _ageH(o.created_at, nowMs) < 12 ? 'criar_musica' : 'travado';
  }
  if (o.status === 'failed') return 'travado';
  return 'em_coleta';
}

async function runLeadStageOnce(reason = 'cron') {
  if (_running) return { skipped: 'já rodando' };
  _running = true;
  const nowMs = Date.now();
  const report = { checked: 0, updated: 0, byStage: {} };
  try {
    const orders = await supaFetch('GET',
      'orders?select=id,phone,status,paid_at,preview_sent_at,delivered_at,created_at,lead_stage,tags,video_upsell_status,video_upsell_paid_at&limit=5000');
    if (!Array.isArray(orders)) { return { ...report, erro: 'query orders falhou' }; }
    const ps = (await supaFetch('GET', 'funnel_events?event_type=eq.price_sent&select=order_id,phone&limit=5000')) || [];
    const psOid = new Set(ps.filter((e) => e.order_id).map((e) => e.order_id));
    const psPhone = new Set(ps.filter((e) => e.phone).map((e) => e.phone));
    const nowIso = new Date(nowMs).toISOString();

    // compras por telefone (pra recorrente/vip)
    const comprasPorTel = {};
    for (const o of orders) { if (_ehCompra(o)) { const t = _digits(o.phone); comprasPorTel[t] = (comprasPorTel[t] || 0) + 1; } }

    for (const o of orders) {
      report.checked++;
      const ns = deriveStage(o, psOid, psPhone, nowMs);
      report.byStage[ns] = (report.byStage[ns] || 0) + 1;
      const patch = {};
      if (o.lead_stage !== ns) { patch.lead_stage = ns; patch.stage_updated_at = nowIso; }
      const newTags = _mergeTags(o.tags, _autoTags(o, comprasPorTel[_digits(o.phone)] || 0));
      if (newTags !== null) patch.tags = newTags;
      if (Object.keys(patch).length > 0) {
        await supaFetch('PATCH', `orders?id=eq.${o.id}`, patch);
        report.updated++;
      }
    }
    if (report.updated > 0 || reason === 'manual') {
      console.log(`[LeadStage] ${reason}: ${report.checked} checados, ${report.updated} atualizados`);
    }
    return report;
  } catch (e) {
    console.error('[LeadStage] erro:', e.message);
    return { ...report, erro: e.message };
  } finally {
    _running = false;
  }
}

function startLeadStageCron() {
  if (_timer) return;
  if (String(process.env.LEAD_STAGE_ENABLED).toLowerCase() !== 'true') {
    console.log('[LeadStage] cron OFF (defina LEAD_STAGE_ENABLED=true)');
    return;
  }
  const min = parseInt(process.env.LEAD_STAGE_INTERVAL_MIN || '10', 10);
  console.log(`[LeadStage] ✅ cron ON — a cada ${min}min`);
  setTimeout(() => {
    runLeadStageOnce();
    _timer = setInterval(runLeadStageOnce, Math.max(2, min) * 60 * 1000);
  }, 90000);
}

module.exports = { runLeadStageOnce, startLeadStageCron, deriveStage };
