// orderReadRoutes — rotas read-heavy / write-leve do recurso /api/order/*.
// Inclui lookup por telefone, gate de RATE LIMIT, polling de status, log de
// erro e pedido de ajuda do cliente.
//
// As rotas mais pesadas (POST /api/order, /:id/update, /:id/photo, /:id/proof,
// /:id/gerar_video_upsell) ficam em orderWriteRoutes.js (Fase F.8.b).
//
// Rotas (5):
//   GET  /api/order/lookup            — busca os ultimos 5 pedidos do telefone
//   GET  /api/order/can_preview       — gate de 24h: 1 previa nao-paga por num
//   GET  /api/order/:id/status        — polling do front
//   POST /api/order/:id/error         — front loga falha
//   POST /api/order/:id/help_request  — cliente pede ajuda (notifica admin Evo)
const express = require('express');
const axios = require('axios');

const { supaFetch } = require('../lib/supabase');
const { isUuid: _isUuid, clip: _clip } = require('../lib/validators');

const router = express.Router();

// GET /api/order/lookup?phone=... (ou ?email=...) — busca os últimos pedidos.
// Telefone: variantes com/sem 55 e com/sem 9. E-mail: match exato (case-insensitive).
router.get('/api/order/lookup', async (req, res) => {
  try {
    const cols = 'id,status,honoree_name,customer_name,phone,preview_audio_url,original_audio_url,full_audio_urls,video_brinde_url,paid_at,created_at';

    // ── Busca por E-MAIL ──
    const email = (req.query.email || '').toString().trim().toLowerCase();
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email invalido' });
      const rows = await supaFetch('GET', `orders?customer_email=eq.${encodeURIComponent(email)}&select=${cols}&order=created_at.desc&limit=5`);
      return res.json({ ok: true, orders: Array.isArray(rows) ? rows : [] });
    }

    // ── Busca por TELEFONE ──
    const raw = (req.query.phone || '').toString().replace(/\D/g, '').slice(0, 15);
    if (raw.length < 10) return res.status(400).json({ error: 'phone invalido' });
    // Normaliza pra numero NACIONAL (10 ou 11 digitos). So remove o "55" quando
    // for CODIGO DE PAIS (numero com 12-13 digitos) — num nacional o "55" inicial
    // e o DDD (Rio Grande do Sul) e NAO pode ser removido.
    const nat = (raw.length >= 12 && raw.startsWith('55')) ? raw.slice(2) : raw;
    const variants = new Set([raw, nat, '55' + nat]);
    // gera com/sem o 9 do celular, nas formas nacional e internacional
    if (nat.length === 11 || nat.length === 10) {
      const ddd = nat.slice(0, 2);
      const rest = nat.slice(2);
      const with9 = rest.length === 9 ? rest : '9' + rest;
      const no9 = rest.length === 9 ? rest.slice(1) : rest;
      for (const r of [with9, no9]) { variants.add(ddd + r); variants.add('55' + ddd + r); }
    }
    // usa eq. em loop (axios encoda mal o in.()) — junta e deduplica
    const byId = {};
    for (const v of variants) {
      const rows = await supaFetch('GET', `orders?phone=eq.${v}&select=${cols}&order=created_at.desc&limit=5`);
      if (Array.isArray(rows)) for (const r of rows) byId[r.id] = r;
    }
    const orders = Object.values(byId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 5);
    res.json({ ok: true, orders });
  } catch (e) {
    console.error('[/api/order/lookup] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// GET /api/order/can_preview?phone=...[&exclude=ID] — RATE LIMIT: cada numero
// pode ter so 1 previa NAO-paga por 24h. Pra pedir outra musica, precisa pagar
// a previa pendente. Retorna o pedido que esta bloqueando.
router.get('/api/order/can_preview', async (req, res) => {
  try {
    const phone = (req.query.phone || '').toString().replace(/\D/g, '').slice(0, 15);
    const exclude = (req.query.exclude || '').toString();
    if (phone.length < 10) return res.json({ blocked: false });
    const variants = new Set([phone]);
    if (phone.startsWith('55')) variants.add(phone.slice(2)); else variants.add('55' + phone);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const cols = 'id,honoree_name,preview_audio_url,status,created_at,paid_at';
    let pend = null;
    for (const v of variants) {
      const rows = await supaFetch('GET', `orders?phone=eq.${v}&paid_at=is.null&select=${cols}&order=created_at.desc&limit=10`);
      for (const o of (Array.isArray(rows) ? rows : [])) {
        if (o.id === exclude) continue;
        if (!['preview_sent', 'generating'].includes(o.status)) continue;
        if (new Date(o.created_at).getTime() < cutoff) continue;
        // prefere um com previa pronta
        if (!pend || (o.status === 'preview_sent' && o.preview_audio_url)) pend = o;
      }
    }
    if (pend) return res.json({ blocked: true, order: pend });
    res.json({ blocked: false });
  } catch (e) {
    console.error('[/api/order/can_preview] erro:', e.message);
    res.json({ blocked: false }); // em erro, nao bloqueia (fail-open)
  }
});

// GET /api/order/:id/status — consulta status do pedido (colunas seguras whitelisted; exige UUID).
router.get('/api/order/:id/status', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    const cols = 'status,preview_audio_url,original_audio_url,full_audio_urls,client_contacted_at,error_message,final_lyrics,video_brinde_url,video_upsell_status,honoree_name,customer_name,phone,paid_at,plan,story,genre,mood,occasion,voice_preference,relationship,style_raw';
    const rows = await supaFetch('GET', `orders?id=eq.${id}&select=${cols}`);
    if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: 'nao encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[/api/order status] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// POST /api/order/:id/error — marca pedido como erro (front chama no catch). PATCH so server-side.
router.post('/api/order/:id/error', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    const msg = _clip((req.body && req.body.error_message) || 'erro no front', 500);
    await supaFetch('PATCH', `orders?id=eq.${id}`, { status: 'error', error_message: msg });
    res.json({ ok: true });
  } catch (e) {
    console.error('[/api/order error] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// POST /api/order/:id/help_request — cliente pediu ajuda apos comprovante rejeitado.
// Salva timestamp no proof_ai_data pra historico e avisa o admin no WhatsApp
// imediatamente (pra ela ja abrir o chat sabendo).
router.post('/api/order/:id/help_request', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ ok: false, reason: 'id invalido' });
    const reasons = Array.isArray(req.body?.reasons) ? req.body.reasons.slice(0, 8) : [];
    const ctx = String(req.body?.context || 'rejected').slice(0, 40);

    // Busca dados do pedido pra montar a notificacao rica
    const rows = await supaFetch('GET',
      `orders?id=eq.${id}&select=id,honoree_name,customer_name,phone,proof_ai_data,proof_status,paid_at,created_at`);
    const o = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!o) return res.status(404).json({ ok: false, reason: 'pedido nao encontrado' });

    // Persiste o ping no proof_ai_data (pra historial). Append-only.
    try {
      const cur = o.proof_ai_data || {};
      const helps = Array.isArray(cur.help_requests) ? cur.help_requests : [];
      helps.push({ at: new Date().toISOString(), context: ctx, reasons });
      cur.help_requests = helps.slice(-10);  // mantem so os 10 ultimos
      await supaFetch('PATCH', `orders?id=eq.${id}`, { proof_ai_data: cur });
    } catch (e) { console.error('[/help_request] persist falhou:', e.message); }

    // Avisa o admin no WhatsApp via Evolution (mesmo canal usado nos comprovantes)
    try {
      const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
      const EVO_KEY = process.env.EVO_KEY || '';
      const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';
      const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511920188319';
      if (EVO_KEY) {
        const id8 = id.slice(0, 8);
        const ai = o.proof_ai_data?.ai || {};
        const msg = [
          '🆘 *Cliente pediu ajuda* (comprovante rejeitado)',
          `Pedido: \`${id8}\``,
          `Cliente: ${o.customer_name || '—'} · ${o.phone || '—'}`,
          `Música pra: ${o.honoree_name || '—'}`,
          ai.valor_reais != null ? `Valor lido: R$ ${ai.valor_reais} · esperado R$ ${o.proof_ai_data?.expected_amount ?? '?'}` : '',
          '',
          reasons.length ? '*Motivos da rejeição:*' : '',
          ...reasons.map(r => `• ${r}`),
          '',
          `_O cliente está abrindo o WhatsApp agora — fica atenta na conversa do ${o.phone || 'cliente'}._`,
        ].filter(Boolean).join('\n');
        await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
          { number: ADMIN_PHONE, text: msg },
          { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
      }
    } catch (notifErr) { console.error('[/help_request] notif admin falhou:', notifErr.message); }

    console.log('[/help_request] cliente abriu WhatsApp:', id, '·', o.phone || '?');
    res.json({ ok: true });
  } catch (e) {
    console.error('[/help_request] erro:', e.message);
    res.status(500).json({ ok: false, reason: 'erro interno' });
  }
});

module.exports = router;
