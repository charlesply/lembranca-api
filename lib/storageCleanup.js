// Cron de LIMPEZA — apaga arquivos de midia >N dias do storage (default: bucket videos)
// + texto de conversa >N dias, PRESERVANDO a ultima __STATE__ de cada numero (memoria do bot).
// NUNCA apaga pedidos (orders) — sao o registro de vendas.
// Gated por CLEANUP_ENABLED=true. Tem dry-run (so simula, nao apaga). try/catch em tudo.
const axios = require('axios');
const { supaFetch } = require('./supabase');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1';
const STORAGE_URL = SUPABASE_URL.replace('/rest/v1', '/storage/v1');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const DAYS = Math.max(1, parseInt(process.env.CLEANUP_DAYS || '7', 10));
const ENABLED = String(process.env.CLEANUP_ENABLED).toLowerCase() === 'true';
const BUCKETS = (process.env.CLEANUP_BUCKETS || 'videos').split(',').map(s => s.trim()).filter(Boolean);
let _timer = null;

const _h = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' });

async function _cleanBucket(bucket, cutoffIso, dryRun) {
  let names = [];
  try {
    const resp = await axios.post(`${STORAGE_URL}/object/list/${bucket}`,
      { limit: 1000, offset: 0, prefix: '', sortBy: { column: 'created_at', order: 'asc' } },
      { headers: _h() });
    const objs = resp.data || [];
    names = objs.filter(o => o && o.created_at && o.created_at < cutoffIso && o.name).map(o => o.name);
  } catch (e) {
    return { bucket, erro: e.response?.data ? JSON.stringify(e.response.data).slice(0, 120) : e.message, apagados: 0 };
  }
  if (names.length && !dryRun) {
    try { await axios.delete(`${STORAGE_URL}/object/${bucket}`, { headers: _h(), data: { prefixes: names } }); }
    catch (e) { return { bucket, achados: names.length, erro: 'delete falhou: ' + e.message, apagados: 0 }; }
  }
  return { bucket, achados: names.length, apagados: dryRun ? 0 : names.length, exemplo: names.slice(0, 5) };
}

async function _cleanMessages(cutoffIso, dryRun) {
  // A) TEXTO antigo (linhas que NAO sao __STATE__)
  let textCount = 0;
  try {
    const get = await supaFetch('GET', `conversations?created_at=lt.${cutoffIso}&content=not.ilike.*__STATE__*&select=id`);
    textCount = Array.isArray(get) ? get.length : 0;
    if (textCount && !dryRun) {
      await supaFetch('DELETE', `conversations?created_at=lt.${cutoffIso}&content=not.ilike.*__STATE__*`);
    }
  } catch (e) {}
  // B) __STATE__ antigas EXCETO a ultima de cada numero (preserva memoria do lead)
  let oldStates = 0, kept = 0;
  try {
    const states = await supaFetch('GET', `conversations?content=ilike.*__STATE__*&select=id,phone,created_at&order=created_at.desc`) || [];
    const latest = new Set(); const seen = new Set();
    for (const s of states) { if (!seen.has(s.phone)) { seen.add(s.phone); latest.add(s.id); } }
    kept = latest.size;
    const del = states.filter(s => s.created_at < cutoffIso && !latest.has(s.id)).map(s => s.id);
    oldStates = del.length;
    if (del.length && !dryRun) {
      for (let i = 0; i < del.length; i += 80) {
        await supaFetch('DELETE', `conversations?id=in.(${del.slice(i, i + 80).join(',')})`);
      }
    }
  } catch (e) {}
  return { textoAntigoApagado: textCount, statesAntigasApagadas: oldStates, statesPreservadas: kept };
}

async function runCleanupOnce(reason = 'cron', dryRun = false) {
  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString();
  console.log(`[cleanup] (${reason}) ${dryRun ? 'DRY-RUN (so simula)' : 'REAL'} | alvo: >${DAYS}d (antes de ${cutoff})`);
  const buckets = [];
  for (const b of BUCKETS) buckets.push(await _cleanBucket(b, cutoff, dryRun));
  const mensagens = await _cleanMessages(cutoff, dryRun);
  const report = { ok: true, dryRun, dias: DAYS, cutoff, buckets, mensagens };
  console.log('[cleanup] relatorio:', JSON.stringify(report));
  return report;
}

function startCleanupCron() {
  if (_timer) return;
  if (!ENABLED) { console.log('[cleanup] desabilitado (CLEANUP_ENABLED != true) — cron NAO iniciado'); return; }
  console.log(`[cleanup] ✅ cron ON — limpeza diaria de midia/mensagens >${DAYS} dias`);
  setTimeout(() => {
    runCleanupOnce('cron').catch(() => {});
    _timer = setInterval(() => runCleanupOnce('cron').catch(() => {}), 24 * 60 * 60 * 1000);
  }, 120000);
}

module.exports = { runCleanupOnce, startCleanupCron };
