// COMANDOS DO ADMIN — processa comandos que o admin manda no WhatsApp (em resposta ao
// relatório). O n8n detecta admin+comando e chama POST /api/admin_command {cmd, phone};
// aqui a gente busca os dados, AGE (ex: re-disparar travados) e RESPONDE no WhatsApp.
// Read-mostly; a única ação que muda estado é TRAVADOS (re-dispara pedidos presos).
const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
const ADMIN_PHONE = process.env.MONITOR_ADMIN_PHONE || '5511920188319';
const PORT = process.env.PORT || 3000;

const _fmt = (v) => Number(v || 0).toFixed(2).replace('.', ',');
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _brazilTodayStartISO() {
  const nowBR = new Date(Date.now() - 3 * 3600 * 1000);
  nowBR.setUTCHours(0, 0, 0, 0);
  return new Date(nowBR.getTime() + 3 * 3600 * 1000).toISOString();
}
async function _send(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
    { number: String(phone).replace(/\D/g, ''), text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
}

// TRAVADOS — lista os presos (24h, não pagos, sem prévia) e RE-DISPARA cada um.
async function _travados(phone) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await supaFetch('GET',
    `orders?or=(status.eq.failed,status.eq.awaiting_retry)&preview_audio_url=is.null&paid_at=is.null&created_at=gte.${since}&error_message=not.ilike.*limpeza*&phone=not.ilike.*912589669*&select=id,honoree_name,phone&order=created_at.desc&limit=20`) || [];
  if (!Array.isArray(rows) || !rows.length) { await _send(phone, '✅ Nenhum pedido travado nas últimas 24h!'); return; }
  let ok = 0;
  for (const o of rows) {
    try { await axios.post(`http://localhost:${PORT}/api/regenerate?orderId=${o.id}`, {}, { timeout: 15000 }); ok++; } catch (e) {}
    await _sleep(900);
  }
  const lista = rows.map((o) => `• ${o.honoree_name || '?'} _(${String(o.phone || '').slice(-4)})_`).join('\n');
  await _send(phone, `🔧 *${rows.length} travado(s)* — re-disparei *${ok}*:\n\n${lista}\n\n_O portão pacea de 2 em 2. As prévias vão chegando._ 💜`);
}

// VENDAS — vendas de hoje (Brasília) com valor e horário.
async function _vendas(phone) {
  const since = _brazilTodayStartISO();
  const rows = await supaFetch('GET',
    `orders?paid_at=gte.${since}&select=honoree_name,phone,amount_cents,paid_at&order=paid_at.desc&limit=60`) || [];
  if (!Array.isArray(rows) || !rows.length) { await _send(phone, '📭 Nenhuma venda hoje ainda. Bora vender! 🚀'); return; }
  let tot = 0;
  const lista = rows.map((o) => {
    const v = o.amount_cents ? o.amount_cents / 100 : 19.90; tot += v;
    const h = (o.paid_at || '').slice(11, 16);
    return `• *${o.honoree_name || '?'}* — R$ ${_fmt(v)} _(${h} UTC)_`;
  }).join('\n');
  await _send(phone, `💳 *Vendas de hoje (${rows.length})* — Total *R$ ${_fmt(tot)}*\n\n${lista}`);
}

// PENDENTES — o que tá na fila de geração agora (ativas no Suno vs esperando vaga).
async function _pendentes(phone) {
  const rows = await supaFetch('GET',
    `orders?status=in.(generating,producing)&preview_audio_url=is.null&select=honoree_name,suno_clip_ids&order=created_at.desc&limit=40`) || [];
  if (!Array.isArray(rows) || !rows.length) { await _send(phone, '✅ Nada na fila — tudo processado!'); return; }
  let ativas = 0, fila = 0;
  const lista = rows.map((o) => {
    if (o.suno_clip_ids) { ativas++; return `• ${o.honoree_name || '?'} — 🎵 gerando`; }
    fila++; return `• ${o.honoree_name || '?'} — ⏳ na fila`;
  }).join('\n');
  await _send(phone, `⏳ *Fila (${rows.length})* — ${ativas} no Suno · ${fila} esperando vaga\n\n${lista}`);
}

// SUNO — saúde do Suno (prévias saindo? falhas? último alerta de cookie?).
async function _suno(phone) {
  let lastAlert = 'nunca';
  try {
    const m = await supaFetch('GET', `system_control?key=eq.cookie_alert_last&select=value`);
    if (Array.isArray(m) && m[0] && m[0].value) lastAlert = Math.round((Date.now() - parseInt(m[0].value, 10)) / 60000) + 'min atrás';
  } catch (e) {}
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const fails = await supaFetch('GET', `orders?or=(status.eq.failed,status.eq.awaiting_retry)&created_at=gte.${since}&select=id`) || [];
  const oks = await supaFetch('GET', `orders?preview_sent_at=gte.${since}&select=id`) || [];
  const nFail = Array.isArray(fails) ? fails.length : 0, nOk = Array.isArray(oks) ? oks.length : 0;
  const saude = nOk > 0 ? '🟢 Aceitando (prévias saindo)' : (nFail > 0 ? '🔴 Possível problema (falhas, sem prévias)' : '🟡 Sem movimento recente');
  await _send(phone, `🎛️ *Status Suno*\n\n${saude}\n\n• Prévias OK (2h): ${nOk}\n• Falhas (2h): ${nFail}\n• Último alerta de cookie: ${lastAlert}\n\n_Se tiver 🔴: entra no Suno, cria 1 música pra renovar e me manda *TRAVADOS*._`);
}

async function _menu(phone) {
  await _send(phone, `🛠️ *Comandos do painel:*\n\n• *TRAVADOS* — re-dispara pedidos presos\n• *VENDAS* — vendas de hoje\n• *PENDENTES* — fila de geração\n• *SUNO* — status do Suno/cookie\n• *RELATORIO* — gera o resumo do dia\n\n📌 *Comprovantes PIX:*\n• *PIX REVISAR* — lista comprovantes em revisão\n• *APROVAR PIX <id8>* — libera a música\n• *REJEITAR PIX <id8>* — rejeita e avisa o cliente`);
}

// ═══════════════════════════════════════════════════════════════
// PIX manual — comandos pra aprovar/rejeitar comprovantes que
// caíram em proof_status='awaiting_validation' (regra anti-fraude
// não auto-aprovou, mas pagamento parece real).
// O cliente vê o desbloqueio automaticamente pelo polling do front.
// ═══════════════════════════════════════════════════════════════

// PIX REVISAR — lista comprovantes pendentes de aprovação manual.
async function _pixRevisar(phone) {
  const rows = await supaFetch('GET',
    `orders?proof_status=eq.awaiting_validation&select=id,honoree_name,customer_name,phone,proof_ai_data,created_at&order=created_at.desc&limit=20`) || [];
  if (!Array.isArray(rows) || !rows.length) {
    await _send(phone, '✅ Nenhum comprovante na fila de revisão!');
    return;
  }
  const lista = rows.map((o) => {
    const ai = o.proof_ai_data?.ai || {};
    const id8 = String(o.id).slice(0, 8);
    const valor = ai.valor_reais != null ? `R$ ${_fmt(ai.valor_reais)}` : 'valor?';
    const benef = ai.beneficiario || 'beneficiário?';
    return `• \`${id8}\` — *${o.honoree_name || o.customer_name || '?'}* _(${String(o.phone || '').slice(-4)})_\n  ${valor} → _${benef}_`;
  }).join('\n\n');
  await _send(phone,
    `📋 *${rows.length} comprovante(s) em revisão:*\n\n${lista}\n\n_Pra aprovar:_ *APROVAR PIX <id8>*\n_Pra rejeitar:_ *REJEITAR PIX <id8>*`);
}

// Acha um order pelo id (UUID curto OU completo).
// UUID curto (8 chars): usa range gte/lt no formato 'c1ce237c-0000-...' ate
// 'c1ce237c-ffff-...' — funciona porque UUIDs sao comparaveis nativamente
// em PostgreSQL (operadores < > >= <= eq). LIKE nao funciona em UUID (42883).
// UUID completo: usa eq direto.
const _ORDER_COLS = 'id,honoree_name,customer_name,phone,paid_at,proof_status,proof_ai_data,bill_id,plan,original_audio_url,full_audio_urls';
async function _findOrderByShortId(idIn) {
  const safe = String(idIn || '').toLowerCase().trim();
  // UUID completo (36 chars com dashes)?
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(safe)) {
    const rows = await supaFetch('GET',
      `orders?id=eq.${safe}&select=${_ORDER_COLS}&limit=2`) || [];
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0];
  }
  // Prefixo curto: usa range UUID (gte ... lte ...)
  if (/^[0-9a-f]{1,8}$/.test(safe)) {
    const pad = safe.padEnd(8, '0');
    const padMax = safe.padEnd(8, 'f');
    // UUID = 8-4-4-4-12 hex chars (12 'f' no ultimo segmento).
    const lo = `${pad}-0000-0000-0000-000000000000`;
    const hi = `${padMax}-ffff-ffff-ffff-ffffffffffff`;
    const rows = await supaFetch('GET',
      `orders?id=gte.${lo}&id=lte.${hi}&select=${_ORDER_COLS}&limit=2`) || [];
    if (!Array.isArray(rows) || !rows.length) return null;
    if (rows.length > 1) return { ambiguous: true, count: rows.length };
    return rows[0];
  }
  return null;
}

// APROVAR PIX <id8> [completa|musica] — marca paid + dispara entrega.
// `planOverride` quando explicitamente passado ('aprovar pix completa <id>'),
// sobrescreve a inferencia. Caso contrario, infere o plano por:
//   1) bill_id contendo "completa" ou "musica" (formato pix_{plan}_{id8})
//   2) valor do comprovante (29.90 -> completa, 19.90 -> musica)
//   3) fallback: musica
async function _pixAprovar(id8, phone, planOverride) {
  const o = await _findOrderByShortId(id8);
  if (!o) { await _send(phone, `❌ Pedido \`${id8}\` não encontrado.`); return; }
  if (o.ambiguous) { await _send(phone, `❌ Id \`${id8}\` ambíguo (${o.count} pedidos). Use 8+ caracteres.`); return; }
  if (o.paid_at) { await _send(phone, `ℹ️ Pedido \`${id8}\` (${o.honoree_name || '?'}) já estava pago.`); return; }

  // Detecta plano (override > coluna plan > bill_id > AI > musica default)
  const ai = o.proof_ai_data?.ai || {};
  let plan = (planOverride || '').toLowerCase();
  if (!plan && o.plan) plan = o.plan;
  if (!plan && o.bill_id && /completa/i.test(o.bill_id)) plan = 'completa';
  if (!plan && o.bill_id && /musica/i.test(o.bill_id)) plan = 'musica';
  const valorAI = ai.valor_reais != null ? Number(ai.valor_reais) : null;
  if (!plan && valorAI != null) plan = Math.round(valorAI * 100) >= 2500 ? 'completa' : 'musica';
  if (!plan) plan = 'musica';
  const valor = valorAI != null ? valorAI : (plan === 'completa' ? 29.90 : 19.90);

  const patch = {
    paid_at: new Date().toISOString(),
    status: 'paid',
    payment_method: 'pix-manual-admin',
    payment_amount: valor,
    proof_status: 'approved',
    plan,
    bill_id: o.bill_id || (`pixadm_${plan}_${o.id.slice(0, 8)}`),
  };
  // Plano 'completa' inclui video karaoke: ja foi pre-gerado em
  // video_brinde_url quando a musica nasceu (ver brindeVideo.js).
  // Marca video_upsell_status pra compatibilidade com cron legado.
  if (plan === 'completa') patch.video_upsell_status = 'pending_photo';

  // garante full_audio_urls pra entrega
  let fau = Array.isArray(o.full_audio_urls) ? o.full_audio_urls.filter(Boolean) : [];
  if (!fau.length && o.original_audio_url) fau = [o.original_audio_url];
  if (fau.length) patch.full_audio_urls = fau;
  await supaFetch('PATCH', `orders?id=eq.${o.id}`, patch);

  // Dispara entrega via webhook do n8n (mesmo caminho do auto-aprovar)
  const N8N_PAY_WEBHOOK_URL = process.env.N8N_PAY_WEBHOOK_URL || '';
  if (N8N_PAY_WEBHOOK_URL) {
    try {
      await axios.post(N8N_PAY_WEBHOOK_URL,
        { event: 'billing.paid', data: { billing: { id: patch.bill_id } } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    } catch (e) { console.error('[adminCommands/aprovar] webhook entrega falhou:', e.message); }
  }
  // Gera brinde
  try { require('./brindeVideo').generateBrindeForOrder(o.id); } catch (e) { console.error('[adminCommands/aprovar] brinde gen falhou:', e.message); }

  const planTag = plan === 'completa' ? ' · *plano: COMPLETA (Música + Vídeo)*' : ' · plano: Música';
  await _send(phone, `✅ Pedido \`${id8}\` *aprovado* — *${o.honoree_name || '?'}* (${String(o.phone || '').slice(-4)})\nValor R$ ${_fmt(valor)}${planTag} · entrega disparada.`);
  console.log('[adminCommands] ✅ APROVADO MANUAL via WhatsApp:', o.id, 'plan:', plan, 'admin:', phone);
}

// REJEITAR PIX <id8> — marca rejected e avisa o cliente.
async function _pixRejeitar(id8, phone) {
  const o = await _findOrderByShortId(id8);
  if (!o) { await _send(phone, `❌ Pedido \`${id8}\` não encontrado.`); return; }
  if (o.ambiguous) { await _send(phone, `❌ Id \`${id8}\` ambíguo (${o.count} pedidos). Use 8+ caracteres.`); return; }
  if (o.paid_at) { await _send(phone, `ℹ️ Pedido \`${id8}\` já estava pago — não dá pra rejeitar.`); return; }

  await supaFetch('PATCH', `orders?id=eq.${o.id}`, { proof_status: 'rejected' });

  // Avisa o cliente no WhatsApp (se tiver telefone)
  if (o.phone) {
    const msg = `Oi! 💜 Sobre seu pedido (#${id8}) — não conseguimos confirmar o pagamento do Pix com o comprovante enviado. Pode mandar de novo um print mais nítido? Se preferir, manda direto pra mim que a gente resolve! 🙌`;
    try { await _send(o.phone, msg); } catch (e) { console.error('[adminCommands/rejeitar] aviso cliente falhou:', e.message); }
  }

  await _send(phone, `❌ Pedido \`${id8}\` *rejeitado* — *${o.honoree_name || '?'}*\nCliente avisado no WhatsApp.`);
  console.log('[adminCommands] ❌ REJEITADO MANUAL via WhatsApp:', o.id, 'admin:', phone);
}

async function handleAdminCommand(cmd, phone) {
  const c = String(cmd || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const to = phone || ADMIN_PHONE;
  try {
    if (/^travados?$/.test(c)) return await _travados(to);
    if (/^vendas?$/.test(c)) return await _vendas(to);
    if (/^pendentes?$/.test(c)) return await _pendentes(to);
    if (/^suno$/.test(c)) return await _suno(to);
    if (/^relatorio$/.test(c)) { const { runDailyReportOnce } = require('./dailyReport'); return await runDailyReportOnce({ send: true }); }
    // ── PIX manual ─────────────────────────────────────────────
    if (/^pix\s+revisar$/.test(c)) return await _pixRevisar(to);
    // "aprovar pix completa <id>" ou "aprovar pix musica <id>" -> com override de plano
    let m = c.match(/^aprovar\s+pix\s+(completa|musica)\s+([a-f0-9-]{6,})$/);
    if (m) return await _pixAprovar(m[2], to, m[1]);
    // "aprovar pix <id>" -> infere o plano automaticamente
    m = c.match(/^aprovar\s+pix\s+([a-f0-9-]{6,})$/);
    if (m) return await _pixAprovar(m[1], to);
    m = c.match(/^rejeitar\s+pix\s+([a-f0-9-]{6,})$/);
    if (m) return await _pixRejeitar(m[1], to);
    return await _menu(to);
  } catch (e) {
    console.error('[adminCommands] erro:', e.message);
    try { await _send(to, '⚠️ Deu um erro ao processar o comando. Tenta de novo em instantes.'); } catch (_) {}
  }
}

module.exports = { handleAdminCommand };
