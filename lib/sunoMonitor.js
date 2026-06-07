// Cron de segurança — varre periodicamente orders que TÊM suno_task_id (ou
// suno_clip_ids) mas estão sem URL de áudio e chama ensureAudioUrls() pra
// resgatar via Suno API ou cdn1.suno.ai direto.
//
// Filosofia: nenhum cliente que pagou pode ficar sem URL salva. Se o webhook
// falhou em salvar (caso histórico Rafael), este cron fecha o buraco.
//
// Gated por SUNO_MONITOR_ENABLED=false pra desligar se precisar.
const axios = require('axios');
const { ensureAudioUrls } = require('./sunoFallback');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const INTERVAL_MIN = Number(process.env.SUNO_MONITOR_INTERVAL_MIN || 5);
const LOOKBACK_HOURS = Number(process.env.SUNO_MONITOR_LOOKBACK_HOURS || 48);

function supaHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function findOrphans() {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  // status in (preview_sent, paid, delivered) — qualquer um que devia ter URL
  // suno_task_id != null + original_audio_url IS NULL = órfão
  const url = `${SUPABASE_URL}/orders?status=in.(preview_sent,paid,delivered)&suno_task_id=not.is.null&original_audio_url=is.null&created_at=gte.${since}&order=created_at.desc&limit=30&select=id,status,paid_at,suno_task_id,honoree_name`;
  try {
    const r = await axios.get(url, { headers: supaHeaders(), timeout: 15000 });
    return r.data || [];
  } catch (e) {
    console.error('[sunoMonitor] erro Supabase:', e.message);
    return [];
  }
}

async function runOnce() {
  const orders = await findOrphans();
  if (!orders.length) {
    console.log('[sunoMonitor] ✅ tudo em dia, 0 orders órfãs');
    return { checked: 0, recovered: 0 };
  }
  console.log(`[sunoMonitor] 🔍 ${orders.length} orders sem URL — tentando resgatar`);
  let recovered = 0;
  let failed = 0;
  for (const o of orders) {
    try {
      const r = await ensureAudioUrls(o.id, { maxRetries: 3, baseDelayMs: 3000 });
      if (r.ok) recovered++;
      else failed++;
    } catch (e) {
      failed++;
      console.error('[sunoMonitor] erro em', o.id.slice(0,8), e.message);
    }
  }
  console.log(`[sunoMonitor] resumo: ${recovered} resgatadas, ${failed} ainda sem URL de ${orders.length}`);
  return { checked: orders.length, recovered, failed };
}

function startCron() {
  if (process.env.SUNO_MONITOR_ENABLED === 'false') {
    console.log('[sunoMonitor] desabilitado (SUNO_MONITOR_ENABLED=false)');
    return;
  }
  console.log(`[sunoMonitor] ✅ cron ON — varre a cada ${INTERVAL_MIN}min orders sem URL (lookback ${LOOKBACK_HOURS}h)`);
  setTimeout(() => { runOnce().catch(e => console.error('[sunoMonitor]', e.message)); }, 45000);
  setInterval(() => { runOnce().catch(e => console.error('[sunoMonitor]', e.message)); }, INTERVAL_MIN * 60 * 1000);
}

module.exports = { startCron, runOnce };
