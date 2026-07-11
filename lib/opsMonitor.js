// MONITOR OPERACIONAL UNIFICADO — alerta por E-MAIL (Resend) o dono quando algo
// sai do normal. Dois ritmos:
//   • AbacatePay a cada 5 min (OPS_ABACATE_INTERVAL_MIN)
//   • resto (disco/SUNOAPI/Supabase/sem-vendas/Inngest) a cada 30 min (OPS_MONITOR_INTERVAL_MIN)
//
// Anti-flood: hysteresis por check — alerta 1x quando cruza pro estado RUIM e
// só re-arma (pode alertar de novo) quando volta pro OK. Estado em memória do
// processo (reseta no restart — e tudo bem: se continuar ruim, alerta na 1ª rodada).
//
// Gated por OPS_MONITOR_ENABLED=false pra desligar tudo.
//
// O sinal do AbacatePay é PASSIVO: o payRoutes chama recordAbacateOutcome(ok)
// em cada /api/pay/create. O monitor lê os outcomes dos últimos 5 min. Se houve
// tentativas reais e TODAS falharam → alerta (sem criar cobrança-lixo).
const axios = require('axios');
const { execSync } = require('child_process');
const { supaFetch } = require('./supabase');
const { getCredits } = require('./sunoApi');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.EMAIL_FROM || 'bia@lembrancacantada.com';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'charles.cmh7@gmail.com';

function num(k, d) { const v = parseInt(process.env[k] == null ? '' : process.env[k], 10); return Number.isFinite(v) ? v : d; }

// ── limiares (tunáveis por env) ─────────────────────────────────────────────
const DISK_MIN_GB           = num('OPS_DISK_MIN_GB', 15);
const SUNO_MIN              = num('OPS_SUNO_MIN', 40000);
const SUPA_DB_LIMIT_GB      = num('OPS_SUPA_DB_LIMIT_GB', 8);    // plano Pro = 8GB DB
const SUPA_STORAGE_LIMIT_GB = num('OPS_SUPA_STORAGE_LIMIT_GB', 100); // Pro = 100GB storage
const SUPA_PCT             = num('OPS_SUPA_PCT', 80);
const NO_SALES_MIN         = num('OPS_NO_SALES_MIN', 15);
const BIZ_START            = num('OPS_BIZ_START_HOUR', 7);       // BRT, inclusive
const BIZ_END              = num('OPS_BIZ_END_HOUR', 23);        // BRT, inclusive (23 → 23:59)
const INNGEST_WINDOW_MIN   = num('OPS_INNGEST_WINDOW_MIN', 20);
const INNGEST_MIN_LEADS    = num('OPS_INNGEST_MIN_LEADS', 8);
const ABACATE_MIN_ATTEMPTS = num('OPS_ABACATE_MIN_ATTEMPTS', 3);
// Check de saúde de pagamento BASEADO NO BANCO (à prova de redeploy — não depende
// do buffer em memória). Só roda quando o provedor ATIVO é abacate (Woovi é
// confiável). Sinal: tráfego (prévias prontas) mas ZERO pagamento na janela.
const PAY_WINDOW_MIN       = num('OPS_PAY_WINDOW_MIN', 8);
const PAY_MIN_PREVIEWS     = num('OPS_PAY_MIN_PREVIEWS', 8);

const SLOW_MIN = Math.max(5, num('OPS_MONITOR_INTERVAL_MIN', 30));
const FAST_MIN = Math.max(1, num('OPS_ABACATE_INTERVAL_MIN', 5));

// ── estado hysteresis por alerta ────────────────────────────────────────────
const _state = {}; // key -> 'ok' | 'bad'

// ── ring buffer dos outcomes do AbacatePay create (compartilhado c/ payRoutes) ──
const _abacate = []; // { t: ms, ok: bool }
function recordAbacateOutcome(ok) {
  _abacate.push({ t: Date.now(), ok: !!ok });
  const cut = Date.now() - 30 * 60 * 1000; // guarda só últimos 30 min
  while (_abacate.length && _abacate[0].t < cut) _abacate.shift();
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function _sendAlert(key, subject, rows) {
  if (!RESEND_API_KEY) { console.warn('[opsMonitor] RESEND_API_KEY ausente — alerta', key, 'não enviado'); return; }
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#2b1d14;max-width:560px">
    <h2 style="color:#b04a30;margin:0 0 12px">🚨 ${esc(subject)}</h2>
    <table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#8a7969">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
    <p style="margin:14px 0 0;color:#8a7969;font-size:12px">Monitor operacional · Lembrança Cantada</p>
  </div>`;
  const text = subject + '\n' + rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  try {
    const r = await axios.post('https://api.resend.com/emails', {
      from: `Alertas Lembrança Cantada <${FROM_EMAIL}>`,
      to: [ALERT_EMAIL],
      subject: `🚨 ${subject}`,
      html, text,
      tags: [{ name: 'kind', value: 'ops-alert' }],
    }, { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    console.log('[opsMonitor] 🚨 alerta enviado:', key, '—', subject, '| id', r.data?.id);
  } catch (e) { console.error('[opsMonitor] envio falhou:', e.response?.data || e.message); }
}

// dispara alerta só na transição ok→bad; loga recovery em bad→ok
async function _evaluate(key, bad, subject, rows) {
  const prev = _state[key] || 'ok';
  if (bad) {
    if (prev !== 'bad') await _sendAlert(key, subject, rows);
    _state[key] = 'bad';
  } else {
    if (prev === 'bad') console.log('[opsMonitor] ✅ recuperado:', key);
    _state[key] = 'ok';
  }
}

// ── CHECKS ──────────────────────────────────────────────────────────────────

async function checkAbacate() {
  const cut = Date.now() - FAST_MIN * 60 * 1000;
  const recent = _abacate.filter(x => x.t >= cut);
  const attempts = recent.length;
  const fails = recent.filter(x => !x.ok).length;
  // só decide com volume mínimo — evita falso positivo em janela sem tentativas
  if (attempts < ABACATE_MIN_ATTEMPTS) return { skipped: true, attempts };
  let bad = fails === attempts; // buffer diz: tudo falhou
  let crossChecked = false;
  if (bad) {
    // CROSS-CHECK no banco (fonte de verdade): se algum PIX (brcode) foi gerado
    // nos últimos 5 min, a AbacatePay ESTÁ funcionando → o buffer enganou (spike
    // de timeouts) → suprime o falso alarme. Só alerta se o banco confirmar 0 PIX.
    const since = new Date(Date.now() - FAST_MIN * 60 * 1000).toISOString();
    const br = await supaFetch('GET', `orders?abacate_brcode=not.is.null&updated_at=gte.${since}&select=id&limit=1`);
    crossChecked = true;
    if (Array.isArray(br) && br.length > 0) bad = false; // gerou PIX → não alerta
  }
  await _evaluate('abacate', bad, 'AbacatePay não está gerando PIX', [
    [`Tentativas (últ. ${FAST_MIN} min)`, String(attempts)],
    ['Falhas', String(fails)],
    ['Confirmado no banco', crossChecked ? 'sim — 0 PIX gerado' : '—'],
    ['Ação', 'Checar AbacatePay — considerar virar PIX_PROVIDER=woovi'],
  ]);
  return { attempts, fails, bad, crossChecked };
}

async function checkDisk() {
  let freeGb = null;
  try {
    const out = execSync('df -k /', { encoding: 'utf8', timeout: 10000 });
    const cols = out.trim().split('\n').pop().split(/\s+/);
    freeGb = Math.round((parseInt(cols[3], 10) / 1024 / 1024) * 10) / 10; // avail KB → GB
  } catch (e) { return { error: e.message }; }
  await _evaluate('disk', freeGb != null && freeGb < DISK_MIN_GB, 'Disco da VPS baixo', [
    ['Livre', `${freeGb} GB`], ['Limiar', `${DISK_MIN_GB} GB`],
  ]);
  return { freeGb };
}

async function checkSuno() {
  let c = null;
  try { c = await getCredits(); } catch (e) { return { error: e.message }; }
  if (typeof c !== 'number') return { note: 'saldo nao numerico', c };
  await _evaluate('suno', c < SUNO_MIN, 'SUNOAPI com créditos baixos', [
    ['Saldo', String(c)], ['Limiar', String(SUNO_MIN)], ['Recarga', 'https://sunoapi.org'],
  ]);
  return { credits: c };
}

async function checkSupabase() {
  let r;
  try { r = await supaFetch('POST', 'rpc/ops_health_sizes', {}); } catch (e) { return { error: e.message }; }
  const row = Array.isArray(r) ? r[0] : r;
  if (!row) return { note: 'sem dados' };
  const dbGb = Number(row.db_bytes) / 1e9;
  const stGb = Number(row.storage_bytes) / 1e9;
  const dbPct = (dbGb / SUPA_DB_LIMIT_GB) * 100;
  const stPct = (stGb / SUPA_STORAGE_LIMIT_GB) * 100;
  const bad = dbPct >= SUPA_PCT || stPct >= SUPA_PCT;
  await _evaluate('supabase', bad, 'Supabase perto do limite', [
    ['DB', `${dbGb.toFixed(2)} GB / ${SUPA_DB_LIMIT_GB} GB (${dbPct.toFixed(0)}%)`],
    ['Storage', `${stGb.toFixed(2)} GB / ${SUPA_STORAGE_LIMIT_GB} GB (${stPct.toFixed(0)}%)`],
    ['Limiar', `${SUPA_PCT}%`],
  ]);
  return { dbGb, stGb, dbPct, stPct };
}

function _brtHour() { return new Date(Date.now() - 3 * 3600 * 1000).getUTCHours(); }
function _brtStamp(ms) { return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '); }

// retorna { gapMin, last } ou null quando a query FALHOU (supaFetch dá null em
// timeout/erro — NUNCA tratar como "sem vendas", senão vira alarme falso no pico)
async function _lastSaleGap() {
  const rows = await supaFetch('GET', 'orders?paid_at=not.is.null&order=paid_at.desc&limit=1&select=paid_at');
  if (!Array.isArray(rows) || !rows[0] || !rows[0].paid_at) return null; // erro/desconhecido
  const last = new Date(rows[0].paid_at).getTime();
  return { gapMin: Math.round((Date.now() - last) / 60000), last };
}

async function checkNoSales() {
  const hour = _brtHour();
  const inBiz = hour >= BIZ_START && hour <= BIZ_END;
  if (!inBiz) { _state['nosales'] = 'ok'; return { skipped: true, hour }; } // fora do horário: não alerta e re-arma
  let r = await _lastSaleGap();
  if (r === null) return { skipped: true, reason: 'query falhou (Supabase) — não alerta' };
  // se parece ruim, RE-CONFIRMA depois de 5s (mata glitch transitório do pico de carga)
  if (r.gapMin >= NO_SALES_MIN) {
    await sleep(5000);
    const r2 = await _lastSaleGap();
    if (r2 === null) return { skipped: true, reason: 'reconfirmação falhou — não alerta' };
    r = r2;
  }
  await _evaluate('nosales', r.gapMin >= NO_SALES_MIN, `Sem vendas há ${r.gapMin} min`, [
    ['Última venda', `${_brtStamp(r.last)} BRT`],
    ['Gap', `${r.gapMin} min`],
    ['Limiar', `${NO_SALES_MIN} min (${BIZ_START}h–${BIZ_END}h59)`],
  ]);
  return { gapMin: r.gapMin, hour };
}

async function checkInngest() {
  // saúde por THROUGHPUT (robusto a zumbis — 'generating' é poluído): se está
  // entrando lead mas NENHUMA prévia sai na janela, a geração (Inngest/Suno) travou.
  const hour = _brtHour();
  const inBiz = hour >= BIZ_START && hour <= BIZ_END;
  if (!inBiz) { _state['inngest'] = 'ok'; return { skipped: true, hour }; }
  const since = new Date(Date.now() - INNGEST_WINDOW_MIN * 60 * 1000).toISOString();
  const leads = await supaFetch('GET', `orders?created_at=gte.${since}&select=id&limit=${INNGEST_MIN_LEADS}`);
  // prévia SENDO produzida = preview_audio_url preenchido + updated_at recente
  // (preview_sent_at foi aposentado — parou de ser gravado em jun/2026)
  const prev = await supaFetch('GET', `orders?preview_audio_url=not.is.null&updated_at=gte.${since}&select=id&limit=1`);
  // se qualquer query FALHOU (null), estado desconhecido → NÃO alerta
  if (!Array.isArray(leads) || !Array.isArray(prev)) return { skipped: true, reason: 'query falhou — não alerta' };
  const nLeads = leads.length;
  const nPrev = prev.length;
  const stuck = nLeads >= INNGEST_MIN_LEADS && nPrev === 0; // inflow sem nenhuma prévia saindo
  await _evaluate('inngest', stuck, 'Geração parada — nenhuma prévia saindo', [
    [`Leads (últ. ${INNGEST_WINDOW_MIN}min)`, `${nLeads}${nLeads >= INNGEST_MIN_LEADS ? '+' : ''}`],
    ['Prévias no período', String(nPrev)],
    ['Sinal', 'Pedidos entrando mas nenhuma prévia sendo gerada (Inngest/Suno)'],
  ]);
  return { nLeads, nPrev, stuck };
}

// Saúde de pagamento pelo BANCO (robusto a redeploy). Só quando abacate está ativo.
// bad = houve TRÁFEGO (prévias prontas) mas ZERO pagamento na janela → PIX travado.
// Pega tanto "não gera PIX" quanto "webhook não confirma" — os dois deixam o
// cliente sem conseguir pagar. Woovi não é monitorado (não cai).
async function checkPaymentHealth() {
  const provider = String(process.env.PIX_PROVIDER || 'abacate').toLowerCase();
  if (provider !== 'abacate') { _state['payhealth'] = 'ok'; return { skipped: true, provider }; }
  const hour = _brtHour();
  if (!(hour >= BIZ_START && hour <= BIZ_END)) { _state['payhealth'] = 'ok'; return { skipped: true, hour }; }
  const since = () => new Date(Date.now() - PAY_WINDOW_MIN * 60 * 1000).toISOString();
  const sample = async () => {
    const prev = await supaFetch('GET', `orders?preview_audio_url=not.is.null&updated_at=gte.${since()}&select=id&limit=${PAY_MIN_PREVIEWS}`);
    const paid = await supaFetch('GET', `orders?paid_at=gte.${since()}&select=id&limit=1`);
    if (!Array.isArray(prev) || !Array.isArray(paid)) return null; // query falhou → desconhecido
    return { nPrev: prev.length, nPaid: paid.length };
  };
  let s = await sample();
  if (s === null) return { skipped: true, reason: 'query falhou — não alerta' };
  // Se parece ruim, RE-CONFIRMA depois de 8s (um pagamento pode cair nesse meio).
  if (s.nPrev >= PAY_MIN_PREVIEWS && s.nPaid === 0) {
    await sleep(8000);
    const s2 = await sample();
    if (s2 === null) return { skipped: true, reason: 'reconfirmação falhou — não alerta' };
    s = s2;
  }
  const bad = s.nPrev >= PAY_MIN_PREVIEWS && s.nPaid === 0;
  await _evaluate('payhealth', bad, 'PIX travado — prévias saindo mas 0 pagamento (AbacatePay?)', [
    [`Prévias (últ. ${PAY_WINDOW_MIN} min)`, `${s.nPrev}${s.nPrev >= PAY_MIN_PREVIEWS ? '+' : ''}`],
    ['Pagamentos no período', String(s.nPaid)],
    ['Provedor ativo', provider],
    ['Ação', 'Testar AbacatePay e VIRAR PIX_PROVIDER=woovi (Woovi não cai)'],
  ]);
  return { nPrev: s.nPrev, nPaid: s.nPaid, bad, provider };
}

async function runFast() {
  const out = {};
  for (const [k, fn] of [['abacate', checkAbacate], ['payhealth', checkPaymentHealth], ['nosales', checkNoSales]]) {
    try { out[k] = await fn(); } catch (e) { out[k] = { error: e.message }; console.error('[opsMonitor] fast', k, 'err', e.message); }
  }
  console.log('[opsMonitor] fast tick', JSON.stringify(out));
  return out;
}

async function runSlow() {
  const out = {};
  for (const [k, fn] of [['disk', checkDisk], ['suno', checkSuno], ['supabase', checkSupabase], ['inngest', checkInngest]]) {
    try { out[k] = await fn(); } catch (e) { out[k] = { error: e.message }; console.error('[opsMonitor]', k, 'err', e.message); }
  }
  console.log('[opsMonitor] slow tick', JSON.stringify(out));
  return out;
}

let _fast = null, _slow = null;
function startCron() {
  if (process.env.OPS_MONITOR_ENABLED === 'false') { console.log('[opsMonitor] desabilitado (OPS_MONITOR_ENABLED=false)'); return; }
  if (_fast || _slow) return;
  console.log(`[opsMonitor] ✅ ON — pagamento/sem-venda a cada ${FAST_MIN}min; disco/suno/supabase/inngest a cada ${SLOW_MIN}min; alertas → ${ALERT_EMAIL}`);
  setTimeout(() => { runFast().catch(() => {}); _fast = setInterval(() => runFast().catch(() => {}), FAST_MIN * 60 * 1000); }, 30 * 1000);
  setTimeout(() => { runSlow().catch(() => {}); _slow = setInterval(() => runSlow().catch(() => {}), SLOW_MIN * 60 * 1000); }, 45 * 1000);
}

module.exports = {
  startCron, recordAbacateOutcome, runFast, runSlow,
  checkAbacate, checkPaymentHealth, checkDisk, checkSuno, checkSupabase, checkNoSales, checkInngest,
};
