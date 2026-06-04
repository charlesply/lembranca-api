// Keep-Warm cron (Fase 2a) — ADITIVO.
// Renova periodicamente a sessao do Suno via Playwright e salva o cookie quente
// na tabela suno_session (single-row, id=1). NINGUEM consome ainda (Fase 2c fara o
// SunoClient ler daqui). Gated por env KEEPWARM_ENABLED=true. Nunca derruba o server.

const { supaFetch } = require('./supabase');
const { resetClient } = require('./suno');

let _running = false;   // evita ticks sobrepostos
let _timer = null;

async function runKeepWarmOnce(reason = 'cron') {
  if (_running) {
    console.log('[KeepWarm] tick ignorado (ja rodando)');
    return { skipped: true };
  }
  _running = true;
  const startedAt = new Date().toISOString();
  try {
    const PlaywrightDriver = require('../PlaywrightDriver');
    console.log(`[KeepWarm] ▶ iniciando (${reason})...`);
    const r = await PlaywrightDriver.keepWarm();

    if (!r || !r.cookie || !r.logged_in) {
      console.warn('[KeepWarm] ⚠ sessao NAO logada ou cookie vazio — nao salva', {
        logged_in: r && r.logged_in, n_keys: r && r.n_keys,
      });
      return { ok: false, logged_in: r && r.logged_in };
    }

    const body = {
      cookie: r.cookie,
      cookie_length: r.cookie_length,
      n_keys: r.n_keys,
      logged_in: r.logged_in,
      session_exp_in_s: r.session_exp_in_s,
      client_exp_days: r.client_exp_days,
      source: reason,
      updated_at: new Date().toISOString(),
    };
    const saved = await supaFetch('PATCH', 'suno_session?id=eq.1', body);
    const okSave = Array.isArray(saved) && saved.length > 0;
    console.log(`[KeepWarm] ✅ salvo=${okSave} len=${r.cookie_length} keys=${r.n_keys} sess_exp=${r.session_exp_in_s}s client=${r.client_exp_days}d`);
    // AUTO-RESET: descarta o SunoClient singleton pra que o proximo getClient()
    // releia o cookie quente fresco da tabela. Sem isso, o singleton fica preso no
    // cookie velho ate um 422 (e se a geracao TRAVA em vez de 422, nunca reseta).
    if (okSave) {
      try { resetClient(); console.log('[KeepWarm] 🔄 SunoClient singleton resetado (vai reler cookie fresco)'); }
      catch (e) { console.warn('[KeepWarm] resetClient falhou (ignorado):', e.message); }
    }
    return { ok: okSave, ...body, cookie: undefined };
  } catch (e) {
    console.error('[KeepWarm] ❌ erro (ignorado, server segue):', e.message);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
  }
}

function startKeepWarmCron() {
  if (String(process.env.KEEPWARM_ENABLED).toLowerCase() !== 'true') {
    console.log('[KeepWarm] desabilitado (KEEPWARM_ENABLED != true) — cron NAO iniciado');
    return;
  }
  if (_timer) return;
  const intervalMin = parseInt(process.env.KEEPWARM_INTERVAL_MIN || '120', 10);
  const intervalMs = Math.max(30, intervalMin) * 60 * 1000;
  const firstDelayMs = parseInt(process.env.KEEPWARM_FIRST_DELAY_S || '90', 10) * 1000;

  console.log(`[KeepWarm] ✅ cron ON — primeira em ${firstDelayMs / 1000}s, depois a cada ${intervalMin}min`);
  setTimeout(() => {
    runKeepWarmOnce('cron-boot');
    _timer = setInterval(() => runKeepWarmOnce('cron'), intervalMs);
  }, firstDelayMs);
}

module.exports = { startKeepWarmCron, runKeepWarmOnce };
