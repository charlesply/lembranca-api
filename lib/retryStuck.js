// Retry Cron INTELIGENTE — recupera pedidos presos por flag transiente do Suno.
// A cada N min: busca orders 'failed' por anti-bot/cookie (transiente), nao pagas, recentes.
// Reprocessa ESPACADO usando o 1o pedido como SONDA: se ele voltar a falhar (422), PARA o
// round pra nao martelar o Suno (que prolongaria o flag). Se recuperar, continua drenando.
// Gated por RETRY_STUCK_ENABLED=true. try/catch — nunca derruba o server.

const axios = require('axios');
const { supaFetch } = require('./supabase');

let _running = false;
let _timer = null;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Falha TRANSIENTE (vale retentar) vs PERMANENTE (nao adianta: moderation/bad request)
function _ehTransiente(msg) {
  const m = msg || '';
  if (/moderation|moderacao|rejeitou|bad.?request|nonretriable|n[aã]o retentar/i.test(m)) return false;
  // inclui falhas de OUTAGE do Suno (clips presos em submitted / timeout ~2h / Suno lento)
  return /cookie|anti.?bot|token_validation|awaiting_retry|expirou|esfriar|retentando|flag|submitted|n[ãa]o completou|completou ap[óo]s|outage|suno (muito )?lento|\bfora\b/i.test(m);
}

async function runRetryStuckOnce(reason = 'cron') {
  if (_running) { console.log('[RetryStuck] tick ignorado (ja rodando)'); return { skipped: true }; }
  _running = true;
  try {
    const PORT = process.env.PORT || 3000;
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString(); // ultimas 12h
    const rows = await supaFetch('GET',
      `orders?status=eq.failed&paid_at=is.null&created_at=gte.${since}&order=created_at.asc&limit=10&select=id,error_message,honoree_name,created_at`);
    const stuck = (Array.isArray(rows) ? rows : []).filter((o) => _ehTransiente(o.error_message));
    if (!stuck.length) { console.log(`[RetryStuck] nenhum preso transiente (${reason})`); return { ok: true, processed: 0 }; }

    console.log(`[RetryStuck] ${stuck.length} preso(s) — reprocessando espacado (${reason})...`);
    let recovered = 0, attempted = 0;
    for (const o of stuck) {
      attempted++;
      try {
        await axios.post(`http://localhost:${PORT}/api/regenerate?orderId=${o.id}`, {}, { timeout: 20000 });
        console.log(`[RetryStuck] ▶ regenerate disparado: ${o.id} (${o.honoree_name || '?'})`);
      } catch (e) { console.log('[RetryStuck] regenerate falhou:', o.id, e.message); }

      // SONDA: o 422 (se houver) se manifesta em segundos. Espera e checa o status.
      await _sleep(75000);
      let st = null;
      try { const chk = await supaFetch('GET', `orders?id=eq.${o.id}&select=status`); st = chk && chk[0] && chk[0].status; } catch (e) {}

      if (st && !['failed', 'awaiting_retry'].includes(st)) {
        recovered++;
        console.log(`[RetryStuck] ✅ ${o.id} recuperou (status=${st}) — Suno saudavel, continua`);
      } else {
        console.log(`[RetryStuck] ⏸ ${o.id} ainda preso (status=${st}) — Suno provavelmente flagado: PARA o round (nao martela)`);
        break;
      }
    }
    return { ok: true, total: stuck.length, attempted, recovered };
  } catch (e) {
    console.error('[RetryStuck] erro (ignorado, server segue):', e.message);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
  }
}

function startRetryStuckCron() {
  if (String(process.env.RETRY_STUCK_ENABLED).toLowerCase() !== 'true') {
    console.log('[RetryStuck] desabilitado (RETRY_STUCK_ENABLED != true) — cron NAO iniciado');
    return;
  }
  if (_timer) return;
  const intervalMin = parseInt(process.env.RETRY_STUCK_INTERVAL_MIN || '30', 10);
  const firstDelayS = parseInt(process.env.RETRY_STUCK_FIRST_DELAY_S || '180', 10);
  console.log(`[RetryStuck] ✅ cron ON — 1a em ${firstDelayS}s, depois a cada ${intervalMin}min`);
  setTimeout(() => {
    runRetryStuckOnce('cron-boot');
    _timer = setInterval(() => runRetryStuckOnce('cron'), Math.max(10, intervalMin) * 60 * 1000);
  }, firstDelayS * 1000);
}

module.exports = { startRetryStuckCron, runRetryStuckOnce };
