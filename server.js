const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ═══ Inngest — fila durável com retry e concorrência ═══
const { serve } = require('inngest/express');
const { inngest } = require('./inngest/client');
const { generateSong } = require('./inngest/functions/generateSong');

// ═══ Helpers compartilhados (lib/) — evita dependência circular ═══
const { supaFetch } = require('./lib/supabase');
const { PAY_PLANS } = require('./lib/payPlans');  // usado em /api/order/:id/proof
const N8N_PAY_WEBHOOK_URL = process.env.N8N_PAY_WEBHOOK_URL || '';  // usado em /api/order/:id/proof
const { generateLyricsWithGPT } = require('./lib/openai');
const { createPreviewFromUrl, PREVIEW_DIR, ORIGINALS_DIR, AUDIO_EDIT_URL, SELF_URL: SELF_URL_LIB } = require('./lib/audio');
const { sendPurchaseToMeta } = require('./lib/metaCapi');
const { getClient, resetClient, isAuthError } = require('./lib/suno');

// ═══ Routers extraídos (refactor Fase F) ═══
const adminRoutes = require('./routes/adminRoutes');
const diagRoutes = require('./routes/diagRoutes');
const cronRoutes = require('./routes/cronRoutes');
const miscRoutes = require('./routes/miscRoutes');
const sunoRoutes = require('./routes/sunoRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const payRoutes = require('./routes/payRoutes');
const orderReadRoutes = require('./routes/orderReadRoutes');

// Multer config: aceita audio ate 25MB (limite do Whisper)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ═══ Routers extraídos (Fase F) — montados no raiz pq cada router
//     traz seu próprio prefixo /api/... ═══
app.use(adminRoutes);
app.use(diagRoutes);
app.use(cronRoutes);
app.use(miscRoutes);
app.use(sunoRoutes);
app.use(webhookRoutes);
app.use(payRoutes);
app.use(orderReadRoutes);

const PORT = process.env.PORT || 3000;
const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SELF_URL = process.env.SELF_URL || 'https://api-suno.linkarbox.app';

// supaFetch, generateLyricsWithGPT, createPreviewFromUrl → importados de lib/

if (!OPENAI_API_KEY) {
  console.warn('\u26a0\ufe0f OPENAI_API_KEY nao configurado - geracao de letra via GPT desabilitada!');
}

if (!SUNO_COOKIE) {
  console.warn('\u26a0\ufe0f SUNO_COOKIE nao configurado nas variaveis de ambiente!');
}

// getClient, resetClient, isAuthError → importados de lib/suno.js

// generateLyricsWithGPT → importado de lib/openai.js
// createPreviewFromUrl → importado de lib/audio.js
// PREVIEW_DIR, ORIGINALS_DIR → importados de lib/audio.js
const AUDIO_EDIT_URL_LOCAL = process.env.AUDIO_EDIT_URL || 'http://audio-edit:5000';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'suno-api-lite', version: '4.0.0', gpt_enabled: !!OPENAI_API_KEY, audio_edit: AUDIO_EDIT_URL_LOCAL, inngest: true });
});

// 8 rotas Suno proxy + file serves + transcribe extraidas pra routes/sunoRoutes.js na Fase F.5



// Rotas de diagnóstico/debug (/api/diag, /api/test-client, /api/test-preview,
// /api/playwright_*, /api/keepwarm_test, /api/active_cookie) extraídas pra
// routes/diagRoutes.js na Fase F.2

// GET /api/keepwarm_run — forca um tick do Keep-Warm e SALVA na tabela suno_session.
// /api/keepwarm_run, /api/upsell_video_run, /api/video_brinde_run,
// /api/monitor_run, /api/daily_report_run, /api/cleanup_run,
// /api/second_version_run, /api/regen_and_send, /api/preview_sender_run,
// /api/retry_stuck_run, /api/recovery/*, /api/leadstage/run, /api/campaign/*
// extraídos pra routes/cronRoutes.js na Fase F.3
// /api/admin_command e /api/admin/* extraídos pra routes/adminRoutes.js na Fase F.1

// POST /api/read_receipt — lê comprovante de pagamento (PDF/imagem) e extrai valor/data/método.
// Body: {base64,mime} OU {url} OU {phone,msgId}. Resolve o cliente que manda PDF do banco.
// /api/read_receipt extraido pra routes/miscRoutes.js na Fase F.4
// /api/cookie_health extraído pra routes/diagRoutes.js na Fase F.2






// /api/chat/ack e /api/generate_and_notify extraidos pra routes/miscRoutes.js na Fase F.4

// ═══════════════════════════════════════════════════════════════
// ORDERS — endpoints seguros p/ o FRONTEND (remove a service_role do site)
// O site NAO fala mais direto com o Supabase. Cria pedido e consulta status
// por aqui. Colunas em WHITELIST: o cliente nao consegue setar status/paid_at,
// nem ler pedidos de outras pessoas (so o proprio id UUID). ADITIVO: nao
// altera generate_and_notify, Inngest, crons nem nada que ja funciona.
// ═══════════════════════════════════════════════════════════════
const _isUuid = (s) => /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(String(s || ''));
const _clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

// Cria um pedido (substitui o INSERT direto que o front fazia com service_role)
app.post('/api/order', async (req, res) => {
  try {
    const b = req.body || {};
    const honoree = (b.honoree_name || b.honoreeName || '').toString().trim();
    if (!honoree) return res.status(400).json({ error: 'honoree_name obrigatorio' });
    const phone = (b.phone || '').toString().replace(/\D/g, '').slice(0, 15) || null;

    // Captura IP + User-Agent do request — usados pelo Meta CAPI pra match quality.
    const ipRaw = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || '';
    const clientIp = String(ipRaw).split(',')[0].trim() || null;
    const clientUA = (req.headers['user-agent'] || '').toString().slice(0, 500) || null;

    // Email — normalizado (lowercase + trim). Vai pro CAPI hashed (user_data.em)
    // pra melhorar Match Quality do Meta Ads. Coluna customer_email VARCHAR(120).
    const emailRaw = String(b.customer_email || b.email || '').trim().toLowerCase().slice(0, 120);
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw);
    const customer_email = emailValid ? emailRaw : null;

    const order = {
      phone,
      ...(customer_email ? { customer_email } : {}),
      honoree_name: _clip(honoree, 120),
      customer_name: _clip(b.customer_name || b.clientName, 120),
      occasion: _clip(b.occasion, 200),
      story: _clip(b.story, 5000),
      style_raw: _clip(b.style_raw, 300),
      genre: _clip(b.genre, 80),
      mood: _clip(b.mood, 80),
      voice_preference: _clip(b.voice_preference || b.voice, 80),
      relationship: _clip(b.relationship, 80),
      // Meta Pixel tracking (pra CAPI server-side disparar pro pixel certo)
      fbp_pixel_id: _clip(b.fbp_pixel_id, 30),
      fbp: _clip(b.fbp, 200),
      fbc: _clip(b.fbc, 200),
      client_ip: clientIp,
      client_user_agent: clientUA,
      status: 'generating', // SEMPRE server-side; cliente nao escolhe
    };
    // Inserção defensiva: se a coluna `customer_email` ainda não existir no DB
    // (transição de schema), Supabase retorna null. Detectamos e re-tentamos
    // sem ela pra venda NUNCA parar por bug de migração. CAPI fallback usa
    // só o que tiver disponível.
    let rows = await supaFetch('POST', 'orders', order);
    if ((!Array.isArray(rows) || !rows[0]) && order.customer_email !== undefined) {
      console.warn('[/api/order] retry sem customer_email (coluna pode não existir no DB ainda)');
      const { customer_email: _ignored, ...orderWithoutEmail } = order;
      rows = await supaFetch('POST', 'orders', orderWithoutEmail);
    }
    const id = Array.isArray(rows) && rows[0] ? rows[0].id : null;
    if (!id) return res.status(500).json({ error: 'falha ao criar pedido' });
    console.log('[/api/order] criado:', id, '|', honoree, customer_email ? '| email ok' : '');
    res.json({ ok: true, orderId: id });
  } catch (e) {
    console.error('[/api/order] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// Consulta pedidos por TELEFONE (cliente que voltou). Retorna os mais recentes,
// apenas colunas seguras. Tenta variantes comuns do numero (com/sem 55, com/sem 9).
// /api/order/lookup, /can_preview, /:id/status, /:id/error extraidos pra routes/orderReadRoutes.js na Fase F.8.a



// Atualiza campos do pedido conforme a conversa anda (persistencia incremental, igual n8n).
// Whitelist de campos seguros — status, preco, midia e flags ficam SEMPRE server-side.
// NOVO: last_screen e events_log permitem crackear onde cada lead parou no quiz.
//       Requer no Supabase: ALTER TABLE orders ADD COLUMN last_screen varchar(40),
//                                              ADD COLUMN events_log text;
app.post('/api/order/:id/update', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    const b = req.body || {};
    const TEXT = {
      honoree_name: 120, customer_name: 120, relationship: 80,
      occasion: 200, story: 5000, genre: 80, mood: 80,
      voice_preference: 80, style_raw: 300,
      last_screen: 40,    // tela em que o lead está no quiz (ex: "childOpen", "review")
      events_log: 8000,   // trilha de eventos do quiz (CSV de "step|screen|ts")
    };
    const patch = {};
    for (const k in TEXT) if (b[k] !== undefined && b[k] !== null) patch[k] = _clip(String(b[k]), TEXT[k]);
    if (b.phone !== undefined) { const p = String(b.phone || '').replace(/\D/g, '').slice(0, 15); patch.phone = p || null; }
    // Email — atualiza só se válido. Normaliza lowercase + trim.
    if (b.customer_email !== undefined || b.email !== undefined) {
      const e = String(b.customer_email || b.email || '').trim().toLowerCase().slice(0, 120);
      if (!e) patch.customer_email = null;
      else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) patch.customer_email = e;
      // email inválido — silenciosamente ignora, não bloqueia o resto do patch
    }
    if (!Object.keys(patch).length) return res.json({ ok: true, updated: 0 });
    // PATCH defensive: se customer_email falhar (coluna ausente), retry sem ele.
    let upd = await supaFetch('PATCH', `orders?id=eq.${id}`, patch);
    if (upd === null && patch.customer_email !== undefined) {
      console.warn('[/api/order/:id/update] retry sem customer_email');
      const { customer_email: _ignored, ...rest } = patch;
      if (Object.keys(rest).length) upd = await supaFetch('PATCH', `orders?id=eq.${id}`, rest);
    }
    res.json({ ok: true, updated: Object.keys(patch).length });
  } catch (e) {
    console.error('[/api/order update] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});


// Upload da FOTO do cliente (plano premium) — só pra pedido PAGO. Sobe no
// Storage e marca pra geracao do video personalizado (cron upsellVideo).
app.post('/api/order/:id/photo', upload.single('photo'), async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    if (!req.file) return res.status(400).json({ error: 'sem foto' });
    if (!/^image\//.test(req.file.mimetype || '')) return res.status(400).json({ error: 'arquivo nao e imagem' });
    // SEGURANCA: so aceita foto de pedido JA PAGO
    const cur = await supaFetch('GET', `orders?id=eq.${id}&select=paid_at,status`);
    const o = Array.isArray(cur) && cur[0] ? cur[0] : null;
    if (!o || !(o.paid_at || ['paid', 'delivered'].includes((o.status || '').toLowerCase()))) {
      return res.status(403).json({ error: 'pedido nao pago' });
    }
    const SUPA_STORAGE = (process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1').replace('/rest/v1', '') + '/storage/v1';
    const SUPA_KEY = process.env.SUPABASE_KEY || '';
    const fname = id + '-' + Date.now() + '.jpg';
    await axios.post(`${SUPA_STORAGE}/object/customer-photos/${fname}`, req.file.buffer, {
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': req.file.mimetype || 'image/jpeg', 'x-upsert': 'true' },
      timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    const photoUrl = `${SUPA_STORAGE}/object/public/customer-photos/${fname}`;
    await supaFetch('PATCH', `orders?id=eq.${id}`, { customer_photo_url: photoUrl, video_upsell_status: 'photo_received' });
    console.log('[/api/order/photo] foto recebida (site) p/', id);
    // GERA o vídeo PERSONALIZADO (com a foto) no próprio backend — fire-and-forget. O chat faz poll e mostra.
    try { require('./lib/brindeVideo').generatePersonalizedForOrder(id); } catch (e) { console.error('[/api/order/photo] gen falhou:', e.message); }
    res.json({ ok: true });
  } catch (e) {
    console.error('[/api/order/photo] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/order/:id/proof — upload de comprovante PIX + validação por IA
// Substituiu o checkout do InfinitePay (cliente paga direto na chave PIX
// e manda o comprovante aqui). A IA lê o comprovante (PDF/imagem) e:
//   - se valor + beneficiário + método baterem com regras estritas → AUTO-APROVA
//   - se passa só parte → marca pra REVISÃO MANUAL (notifica admin)
//   - se claramente não é comprovante → REJEITA
// Camadas anti-fraude:
//   1) Tamanho ≤ 5 MB · MIME whitelist (image/* | application/pdf)
//   2) Hash SHA-256 — se já foi usado em OUTRA order, rejeita (anti-reuso)
//   3) Idempotência — order já paga não aceita novo upload
//   4) Validação IA: valor EXATO, beneficiário contém marca, PIX, conf ≥ 0.85
//   5) Data do comprovante ≤ 72h (rejeita comprovante antigo)
//   6) Tudo registrado: proof_url, proof_hash, proof_ai_data, proof_status
//
// ⚠️  REQUER no Supabase:
//     - Bucket público "receipts" criado em Storage.
//     - ALTER TABLE orders ADD COLUMN proof_url text,
//                          ADD COLUMN proof_hash text,
//                          ADD COLUMN proof_ai_data jsonb,
//                          ADD COLUMN proof_status varchar(30);
//     - CREATE INDEX ON orders(proof_hash);
// ═══════════════════════════════════════════════════════════════
app.post('/api/order/:id/proof', upload.single('proof'), async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ ok: false, reason: 'id invalido' });
    if (!req.file) return res.status(400).json({ ok: false, reason: 'sem arquivo' });

    // ── 1) MIME + tamanho ───────────────────────────────────────
    const mime = (req.file.mimetype || '').toLowerCase();
    const isImage = /^image\//.test(mime);
    const isPdf   = mime === 'application/pdf';
    if (!isImage && !isPdf) {
      return res.status(400).json({ ok: false, reason: 'tipo de arquivo inválido (envie foto ou PDF)' });
    }
    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ ok: false, reason: 'arquivo maior que 5MB' });
    }

    // ── 2) Hash anti-reuso ──────────────────────────────────────
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    // Verifica se esse hash JÁ foi usado em OUTRA order
    const dup = await supaFetch('GET', `orders?proof_hash=eq.${hash}&id=neq.${id}&select=id,paid_at&limit=1`);
    if (Array.isArray(dup) && dup[0]) {
      console.warn('[/api/order/proof] HASH DUPLICADO:', hash.slice(0, 12), 'já em order', dup[0].id);
      return res.status(409).json({
        ok: false,
        reason: 'esse comprovante já foi enviado em outro pedido — envie o seu original',
        proof_status: 'rejected',
      });
    }

    // ── 3) Idempotência ─────────────────────────────────────────
    const cur = await supaFetch('GET', `orders?id=eq.${id}&select=id,paid_at,status,proof_status,bill_id,phone,honoree_name,customer_name`);
    const o = Array.isArray(cur) && cur[0] ? cur[0] : null;
    if (!o) return res.status(404).json({ ok: false, reason: 'pedido não encontrado' });
    if (o.paid_at || ['paid', 'delivered'].includes((o.status || '').toLowerCase())) {
      return res.json({ ok: true, already_paid: true, proof_status: 'approved' });
    }

    // Qual plano? (preço esperado · vem do bill_id 'ip_xxx' ou default 'musica')
    // PAY_PLANS está no escopo deste server.js
    const plan = (req.body && req.body.plan) || 'musica';
    const expectedAmount = (PAY_PLANS[plan] && PAY_PLANS[plan].cents / 100) || 19.90;

    // ── 4) Sobe pro Supabase Storage ────────────────────────────
    const SUPA_STORAGE = (process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1').replace('/rest/v1', '') + '/storage/v1';
    const SUPA_KEY = process.env.SUPABASE_KEY || '';
    const ext = isPdf ? 'pdf' : (mime.split('/')[1] || 'jpg');
    const fname = id + '-' + Date.now() + '.' + ext;
    let proofUrl = null;
    try {
      await axios.post(`${SUPA_STORAGE}/object/receipts/${fname}`, req.file.buffer, {
        headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity,
      });
      proofUrl = `${SUPA_STORAGE}/object/public/receipts/${fname}`;
    } catch (upErr) {
      console.error('[/api/order/proof] storage falhou:', upErr.message);
      // segue mesmo sem URL — IA lê do buffer direto
    }

    // ── 5) Validação IA ─────────────────────────────────────────
    const { readReceipt } = require('./lib/readReceipt');
    let ai = null;
    try {
      const base64 = req.file.buffer.toString('base64');
      ai = await readReceipt({ base64, mime });
    } catch (aiErr) {
      console.error('[/api/order/proof] IA falhou:', aiErr.message);
      ai = { e_comprovante: false, erro: 'IA indisponível' };
    }

    // ── 6) Regras anti-fraude ───────────────────────────────────
    // Motivos são strings PRONTAS pra exibir pro cliente, em pt-BR claro.
    // Cada falha aparece como item da lista no modal (rejected / review).
    const reasons = [];
    let proofStatus = 'awaiting_validation';
    let autoApprove = false;

    // ↓ helper de moeda BR · "1990" → "R$ 19,90"
    const fmtBRL = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');

    // ↓ parse de data brasileira → milissegundos UTC reais (assume horário São Paulo, UTC-3).
    //   Aceita "03/06/2026 às 13:03:44", "02/jun/2026 - 18:11:47", "03/06/2026", etc.
    const parseReceiptDateSP = (raw) => {
      if (!raw) return null;
      const monthMap = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };
      const s = String(raw).toLowerCase()
        .replace(/\s+às\s+/g, ' ').replace(/\s+-\s+/g, ' ')
        .replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
      let m = s.match(/(\d{1,2})[\/\- ](\d{1,2})[\/\- ](\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
      let dd, mm, yy, hh = 12, mi = 0, ss = 0;
      if (m) {
        dd = +m[1]; mm = +m[2]; yy = +m[3];
        if (m[4]) { hh = +m[4]; mi = +m[5]; ss = +(m[6] || 0); }
      } else {
        m = s.match(/(\d{1,2})[\/\- ]([a-zç]{3,})[\/\- ](\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (!m) return null;
        dd = +m[1]; mm = monthMap[m[2].slice(0, 3)] || 0; yy = +m[3];
        if (m[4]) { hh = +m[4]; mi = +m[5]; ss = +(m[6] || 0); }
      }
      if (!dd || !mm || !yy) return null;
      if (yy < 100) yy += 2000;
      // SP é UTC-3 → momento real em UTC = horário SP + 3h
      return Date.UTC(yy, mm - 1, dd, hh + 3, mi, ss);
    };

    // ↓ formata data BR no fuso SP a partir de ms UTC
    const fmtDateSP = (utcMs) => {
      try {
        return new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }).format(new Date(utcMs));
      } catch (_) { return new Date(utcMs).toISOString(); }
    };

    if (!ai || ai.e_comprovante !== true) {
      proofStatus = 'rejected';
      reasons.push('O arquivo enviado não parece um comprovante de pagamento.');
    } else {
      // — confirmação de pagamento
      if (ai.confirma_pagamento !== true) {
        reasons.push('O comprovante não mostra o pagamento como concluído.');
      }
      // — valor
      //   • aceita: igual, MAIOR (gorjeta/arredondamento pra cima), ou
      //     até R$ 1,00 A MENOS (apps que mostram só R$ 19 num plano de R$ 19,90).
      //   • rejeita: menos que (plano - R$ 1,00)
      //   Pra plano musica (R$ 19,90) → mínimo R$ 19,00.
      //   Pra plano completa (R$ 29,90) → mínimo R$ 28,90.
      const VALOR_TOLERANCIA_NEG = 1.00;            // pode pagar até 1 real a menos
      const minAceito = +(expectedAmount - VALOR_TOLERANCIA_NEG).toFixed(2);
      let valorOk = false;
      if (typeof ai.valor_reais !== 'number') {
        reasons.push('Não conseguimos identificar o valor pago no comprovante.');
      } else if (ai.valor_reais < minAceito - 0.01) {
        // pagou MENOS que o mínimo aceito → rejeita
        const falta = expectedAmount - ai.valor_reais;
        reasons.push(`O valor pago (${fmtBRL(ai.valor_reais)}) é menor que o mínimo do seu pedido (${fmtBRL(minAceito)}). Faltam ${fmtBRL(falta)}.`);
      } else {
        valorOk = true;
        // pagou menos que o plano mas dentro da tolerância? registra pro admin saber
        if (ai.valor_reais < expectedAmount - 0.01) {
          ai._underpaid_within_tolerance = +(expectedAmount - ai.valor_reais).toFixed(2);
        }
        // pagou mais que o plano? também registra
        if (ai.valor_reais > expectedAmount + 0.01) {
          ai._overpaid = +(ai.valor_reais - expectedAmount).toFixed(2);
        }
      }
      // — método PIX
      const metodo = String(ai.metodo || '').toLowerCase();
      const pixOk = /pix/.test(metodo);
      if (!pixOk) {
        reasons.push(`O pagamento precisa ser por PIX${ai.metodo ? ` — o comprovante mostra ${ai.metodo}.` : '.'}`);
      }
      // — beneficiário (titular da conta = NIKELSON DA SILVA, CPF 131.950.597-03)
      //   bate se o nome lido tiver "nikelson" OU "silva" (sobrenome pode aparecer
      //   sozinho em alguns recibos)
      const benefRaw = String(ai.beneficiario || '').trim();
      const benefNorm = benefRaw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const looksLikeMe = /nikelson|\bsilva\b/.test(benefNorm);
      let benefOk = true;
      if (benefRaw && !looksLikeMe) {
        benefOk = false;
        reasons.push(`O PIX foi para "${benefRaw}". Precisa ser para NIKELSON DA SILVA (CPF 131.950.597-03), responsável pelos pagamentos.`);
      }
      // — confiança da leitura
      let confOk = true;
      if (typeof ai.confianca === 'number' && ai.confianca < 0.85) {
        confOk = false;
        reasons.push(`A leitura ficou pouco nítida (${Math.round(ai.confianca * 100)}%). Tente enviar uma imagem maior ou um PDF.`);
      }
      // — data ≤ 72h e não no futuro (horário São Paulo)
      let dataOk = true;
      const reciboMs = parseReceiptDateSP(ai.data);
      if (reciboMs) {
        const ageHours = (Date.now() - reciboMs) / 3600000;
        if (ageHours > 72) {
          dataOk = false;
          reasons.push(`O comprovante é de ${fmtDateSP(reciboMs)} — só aceitamos pagamentos das últimas 72h.`);
        } else if (ageHours < -1) {
          // mais de 1h "no futuro" = data adulterada
          dataOk = false;
          reasons.push(`A data do comprovante (${fmtDateSP(reciboMs)}) está adiante do horário atual de São Paulo.`);
        }
      } else if (ai.data) {
        // tinha data mas não conseguimos parsear — manda pra revisão manual
        reasons.push(`Não conseguimos interpretar a data do comprovante ("${ai.data}").`);
      }
      // — Decisão final
      const confirmOk = ai.confirma_pagamento === true;
      if (valorOk && pixOk && confOk && benefOk && dataOk && confirmOk && reasons.length === 0) {
        autoApprove = true;
        proofStatus = 'approved';
      } else if (confirmOk && pixOk && valorOk && dataOk) {
        // pagamento parece real (PIX + valor certo + data válida) mas algo dos
        // "suaves" falhou (beneficiário não-encontrado, confiança baixa) — revisão.
        proofStatus = 'awaiting_validation';
      } else {
        proofStatus = 'rejected';
      }
    }

    // ── 7) Persiste ─────────────────────────────────────────────
    const proofData = {
      ai, expected_amount: expectedAmount, plan,
      reasons, received_at: new Date().toISOString(),
      file: { name: req.file.originalname, mime, size: req.file.size },
    };
    const patch = {
      proof_url: proofUrl,
      proof_hash: hash,
      proof_ai_data: proofData,
      proof_status: proofStatus,
    };

    // Se auto-aprovado → marca paid_at e dispara entrega
    if (autoApprove) {
      patch.paid_at = new Date().toISOString();
      patch.status = 'paid';
      // Codificamos o plano dentro do bill_id pra nao precisar de coluna nova
      // (orders nao tem coluna "plan"). Formato: pix_{plan}_{id8}.
      // Usado pelo admin command "aprovar pix" pra restaurar o tipo de plano
      // caso a aprovacao caia em fluxo manual.
      patch.payment_method = 'pix-manual-ia';
      patch.payment_amount = expectedAmount;
      patch.plan = plan;
      patch.bill_id = o.bill_id || (`pix_${plan}_${id.slice(0, 8)}`);
      // Plano 'completa' = R$29,90 = MUSICA + VIDEO KARAOKE. Marca o pedido
      // como aguardando a foto que o cliente vai mandar no WhatsApp pra
      // gerar o video personalizado. Mesma flag usada no /api/pay/verify.
      if (plan === 'completa') {
        patch.video_upsell_status = 'pending_photo';
      }
      // garante full_audio_urls
      try {
        const curOrder = await supaFetch('GET', `orders?id=eq.${id}&select=original_audio_url,full_audio_urls`);
        const oo = Array.isArray(curOrder) && curOrder[0] ? curOrder[0] : null;
        let fau = Array.isArray(oo?.full_audio_urls) ? oo.full_audio_urls.filter(Boolean) : [];
        if (!fau.length && oo?.original_audio_url) fau = [oo.original_audio_url];
        if (fau.length) patch.full_audio_urls = fau;
      } catch (_) {}
    }
    await supaFetch('PATCH', `orders?id=eq.${id}`, patch);

    // ── 8) Webhooks pós-aprovação ───────────────────────────────
    if (autoApprove) {
      if (N8N_PAY_WEBHOOK_URL) {
        try {
          await axios.post(N8N_PAY_WEBHOOK_URL,
            { event: 'billing.paid', data: { billing: { id: patch.bill_id } } },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
        } catch (e) { console.error('[/api/order/proof] webhook entrega falhou:', e.message); }
      }
      try { require('./lib/brindeVideo').generateBrindeForOrder(id); } catch (e) { console.error('[/api/order/proof] brinde gen falhou:', e.message); }
      console.log('[/api/order/proof] ✅ AUTO-APROVADO via IA:', id, '· R$', expectedAmount);
    } else if (proofStatus === 'awaiting_validation') {
      // notifica admin no WhatsApp (Evolution) com link do comprovante e razões
      try {
        const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
        const EVO_KEY = process.env.EVO_KEY || '';
        const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
        const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511920188319';
        const id8 = id.slice(0, 8);
        const msg = [
          '🔔 *Comprovante pra revisar*',
          `Pedido: \`${id8}\``,
          `Cliente: ${o.customer_name || '—'} · ${o.phone || '—'}`,
          `Valor lido: R$ ${ai?.valor_reais ?? '?'} · esperado R$ ${expectedAmount}`,
          `Beneficiário: ${ai?.beneficiario || '?'}`,
          `Confiança: ${ai?.confianca ?? '?'}`,
          `Data: ${ai?.data || '?'}`,
          '',
          `*Motivos:*`,
          ...reasons.map(r => `• ${r}`),
          '',
          proofUrl ? `📎 Link: ${proofUrl}` : '',
          '',
          `_Pra decidir:_`,
          `• *APROVAR PIX ${id8}* — libera a música`,
          `• *REJEITAR PIX ${id8}* — rejeita e avisa o cliente`,
        ].filter(Boolean).join('\n');
        if (EVO_KEY) {
          await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
            { number: ADMIN_PHONE, text: msg },
            { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
        }
      } catch (notifErr) { console.error('[/api/order/proof] notif admin falhou:', notifErr.message); }
      console.log('[/api/order/proof] ⏳ EM REVISÃO:', id, '· motivos:', reasons.join('; '));
    } else {
      console.log('[/api/order/proof] ❌ REJEITADO:', id, '· motivos:', reasons.join('; '));
    }

    // ── 9) Resposta ─────────────────────────────────────────────
    res.json({
      ok: true,
      proof_status: proofStatus,
      auto_approved: autoApprove,
      reasons,
      ai: ai ? {
        valor_reais: ai.valor_reais,
        confirma_pagamento: ai.confirma_pagamento,
        metodo: ai.metodo,
        beneficiario: ai.beneficiario,
        confianca: ai.confianca,
        resumo: ai.resumo,
      } : null,
    });
  } catch (e) {
    console.error('[/api/order/proof] erro:', e.message);
    res.status(500).json({ ok: false, reason: 'erro interno' });
  }
});

// PEDIDO DE AJUDA — quando o cliente clica em "Falar com a Bia no WhatsApp"
// /api/order/:id/help_request extraido pra routes/orderReadRoutes.js na Fase F.8.a

// ═══════════════════════════════════════════════════════════════════════════
// Webhook callback do sunoapi.org. É chamado em 4 momentos:
//   • text     — lyrics geradas (não usamos, já temos GPT)
//   • first    — primeira faixa pronta (latência mais baixa)
//   • complete — todas as faixas prontas
//   • error    — geração falhou
//
// /api/webhooks/sunoapi extraido pra routes/webhookRoutes.js na Fase F.6

// DISPARO IMEDIATO do vídeo do UPSELL (WhatsApp) — o n8n chama isto assim que a foto chega,
// pra gerar+enviar NA HORA em vez de esperar o cron (~2min). O cron continua de backup.
app.post('/api/order/:id/gerar_video_upsell', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    res.json({ ok: true, triggered: true });  // responde rápido
    // dispara o tick do cron de upsell (processa photo_received -> gera -> envia no WhatsApp). fire-and-forget.
    try { require('./lib/upsellVideo').runUpsellVideoOnce('trigger-foto-' + id.slice(0, 8)); }
    catch (e) { console.error('[gerar_video_upsell] tick falhou:', e.message); }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'erro interno' });
  }
});

// PAY_PLANS, /api/pay/create, /api/pay/status, /api/pay/verify extraidos pra routes/payRoutes.js na Fase F.7


// /api/webhooks/abacatepay extraido pra routes/webhookRoutes.js na Fase F.6


// /api/regenerate extraido pra routes/miscRoutes.js na Fase F.4

// /api/admin/* extraídos pra routes/adminRoutes.js na Fase F.1
// ═══ Inngest handler — recebe webhooks do Inngest Cloud ═══
app.use('/api/inngest', serve({
  client: inngest,
  functions: [generateSong],
}));

process.on('uncaughtException', (err) => console.error('\u26a0\ufe0f Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('\u26a0\ufe0f Rejection:', reason?.message || reason));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n\ud83c\udfb5 suno-api-lite v4.0.0 + Inngest rodando na porta ${PORT}`);
  console.log(`   Inngest: \u2705 habilitado (concurrency: 2, retries: 3)`);
  console.log(`   GPT Lyrics: ${OPENAI_API_KEY ? '\u2705 habilitado' : '\u274c desabilitado'}`);
  console.log(`   Whisper: ${OPENAI_API_KEY ? '\u2705 habilitado' : '\u274c desabilitado'}`);
  console.log(`   Audio-Edit: ${AUDIO_EDIT_URL_LOCAL}`);
  console.log(`   Webhook n8n: ${N8N_WEBHOOK_URL || '(nao configurado)'}\n`);
  if (SUNO_COOKIE) {
    console.log('Tentando inicializar SunoClient em background...');
    getClient().then(() => console.log('\u2705 SunoClient inicializado!'))
      .catch(err => { console.error('\u26a0\ufe0f Falha SunoClient:', err.message); });
  }
  // Auto re-sync com Inngest Cloud no boot. CR\u00cdTICO: todo deploy/restart dessincroniza o app
  // do Cloud (os eventos param de virar runs \u2192 m\u00fasicas travam em 'generating'). Esse PUT
  // re-registra as fun\u00e7\u00f5es automaticamente, pra gera\u00e7\u00e3o nunca mais quebrar por deploy.
  setTimeout(() => {
    axios.put(`http://127.0.0.1:${PORT}/api/inngest`, {}, { timeout: 30000 })
      .then((r) => console.log('[Inngest] \u2705 auto-resync no boot:', (r.data && r.data.message) || r.status))
      .catch((e) => console.error('[Inngest] auto-resync falhou (ignorado):', e.message));
  }, 30000);
  // Keep-Warm cron (Fase 2a) \u2014 gated por KEEPWARM_ENABLED=true. Aditivo, nao quebra nada.
  try {
    const { startKeepWarmCron } = require('./lib/keepWarm');
    startKeepWarmCron();
  } catch (err) { console.error('[KeepWarm] falha ao iniciar cron (ignorado):', err.message); }
  // Retry Cron Inteligente \u2014 gated por RETRY_STUCK_ENABLED=true. Recupera presos sem martelar.
  try {
    const { startRetryStuckCron } = require('./lib/retryStuck');
    startRetryStuckCron();
  } catch (err) { console.error('[RetryStuck] falha ao iniciar cron (ignorado):', err.message); }
  // Cron do V\u00eddeo de Brinde \u2014 gated por VIDEO_BRINDE_ENABLED=true. Envia o v\u00eddeo guardado
  // quando o cliente responde (surpresa) ou como garantia ap\u00f3s X min.
  try {
    const { startVideoBrindeCron } = require('./lib/videoBrinde');
    startVideoBrindeCron();
  } catch (err) { console.error('[VideoBrinde] falha ao iniciar cron (ignorado):', err.message); }
  // Cron do V\u00eddeo Personalizado (upsell) \u2014 gated por UPSELL_VIDEO_ENABLED=true.
  try {
    const { startUpsellVideoCron } = require('./lib/upsellVideo');
    startUpsellVideoCron();
  } catch (err) { console.error('[UpsellVideo] falha ao iniciar cron (ignorado):', err.message); }
  // Cron de GERAÇÃO do vídeo de brinde (fluxo do SITE, independente do n8n) — rede de segurança.
  try {
    const { startBrindeGenCron } = require('./lib/brindeVideo');
    startBrindeGenCron();
  } catch (err) { console.error('[BrindeVideo] falha ao iniciar cron (ignorado):', err.message); }
  // Cron CAPI Monitor — rede de segurança pra Meta CAPI. Varre orders pagas das últimas 24h
  // sem meta_capi_sent e reenvia o Purchase. Cobre falhas do webhook AbacatePay, restart no
  // exato momento do pagamento, token vazio, etc. Default ON em prod.
  try {
    const { startCron: startCapiMonitorCron } = require('./lib/capiMonitor');
    startCapiMonitorCron();
  } catch (err) { console.error('[capiMonitor] falha ao iniciar cron (ignorado):', err.message); }
  // Cron Suno Monitor — rede de segurança pra garantir URL de áudio. Varre orders com
  // suno_task_id mas sem original_audio_url (lookback 48h) e resgata via Suno API +
  // cdn1.suno.ai/{clipId}.mp3 com retry 5x. Cobre webhook complete que não salvou URL,
  // Inngest que viu FAILED em record-info stale, etc. Default ON.
  try {
    const { startCron: startSunoMonitorCron } = require('./lib/sunoMonitor');
    startSunoMonitorCron();
  } catch (err) { console.error('[sunoMonitor] falha ao iniciar cron (ignorado):', err.message); }
  // Cron Email Delivery Monitor — rede de segurança pra email transacional. Varre orders
  // pagas com email + áudio pronto sem email_delivery_sent. Reenvia em até 10 min.
  // Gated por RESEND_API_KEY existir (senão nem inicia).
  try {
    const { startCron: startEmailDeliveryCron } = require('./lib/emailDeliveryMonitor');
    startEmailDeliveryCron();
  } catch (err) { console.error('[emailDeliveryMonitor] falha ao iniciar cron (ignorado):', err.message); }
  // Funil de Recuperação — gated por RECOVERY_ENABLED=true (default OFF). Recupera leads quentes
  // (prévia enviada, não pago) com mensagens escalonadas. Respeita teste/dry-run/pause/opt-out.
  try {
    const { startRecoveryCron } = require('./lib/recoveryFunnel');
    startRecoveryCron();
  } catch (err) { console.error('[Recovery] falha ao iniciar cron (ignorado):', err.message); }
  // Funil de Leads — mantém orders.lead_stage automaticamente (deriva do que o n8n já escreve,
  // NÃO toca no n8n). Gated por LEAD_STAGE_ENABLED=true. Pra segmentar marketing por estágio.
  try {
    const { startLeadStageCron } = require('./lib/leadStage');
    startLeadStageCron();
  } catch (err) { console.error('[LeadStage] falha ao iniciar cron (ignorado):', err.message); }
  // Campanhas automáticas por estágio — gated por CAMPAIGN_AUTO_ENABLED. Só leads de hoje
  // em diante (CAMPAIGN_SINCE). Substitui o funil de recuperação antigo (não tocar no n8n).
  try {
    const { startCampaignCron } = require('./lib/campaigns');
    startCampaignCron();
  } catch (err) { console.error('[Campaigns] falha ao iniciar cron (ignorado):', err.message); }

  try {
    const { startSiteMonitorCron } = require('./lib/siteMonitor');
    startSiteMonitorCron();
  } catch (err) { console.error('[siteMonitor] falha ao iniciar cron (ignorado):', err.message); }

  try {
    const { startDailyReportCron } = require('./lib/dailyReport');
    startDailyReportCron();
  } catch (err) { console.error('[dailyReport] falha ao iniciar cron (ignorado):', err.message); }

  try {
    const { startCleanupCron } = require('./lib/storageCleanup');
    startCleanupCron();
  } catch (err) { console.error('[cleanup] falha ao iniciar cron (ignorado):', err.message); }

  try {
    const { startSecondVersionCron } = require('./lib/secondVersionBrinde');
    startSecondVersionCron();
  } catch (err) { console.error('[secondVersion] falha ao iniciar cron (ignorado):', err.message); }

  try {
    const { startPreviewSenderCron } = require('./lib/regenPreview');
    startPreviewSenderCron();
  } catch (err) { console.error('[regenPreview] falha ao iniciar cron (ignorado):', err.message); }
});
