// orderWriteRoutes — rotas write-heavy do recurso /api/order/*.
//
// Rotas (5):
//   POST /api/order                       — cliente envia o quiz (cria pedido)
//   POST /api/order/:id/update            — atualizacao incremental durante quiz
//   POST /api/order/:id/photo             — upload foto do upsell (multer + storage)
//   POST /api/order/:id/proof             — comprovante PIX + validacao IA
//   POST /api/order/:id/gerar_video_upsell — dispara o cron de upsell na hora
//
// As rotas mais leves (lookup, can_preview, status, error, help_request) ficam
// em orderReadRoutes.js (Fase F.8.a).
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const crypto = require('crypto');

const { supaFetch } = require('../lib/supabase');
const { PAY_PLANS } = require('../lib/payPlans');
const { isUuid: _isUuid, clip: _clip } = require('../lib/validators');

const router = express.Router();

// Multer config local — aceita ate 25MB (foto/comprovante). Mesmo limite do
// transcribe; o /proof tem cap adicional de 5MB checado dentro do handler.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// N8N_PAY_WEBHOOK_URL: ja avaliado em server.js tbm pq /api/pay/verify usa.
// Aqui repetimos a leitura pq esse modulo nao depende do server.js.
const N8N_PAY_WEBHOOK_URL = process.env.N8N_PAY_WEBHOOK_URL || '';

// POST /api/order — cria um pedido (substitui o INSERT direto que o front fazia com service_role).
// Captura IP + User-Agent pra Meta CAPI Match Quality. Email normalizado (lowercase+trim) vai
// pro CAPI hashed (user_data.em). Defensivo: se coluna customer_email nao existir no DB,
// retenta sem ela.
router.post('/api/order', async (req, res) => {
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
    // Insercao defensiva: se a coluna `customer_email` ainda nao existir no DB
    // (transicao de schema), Supabase retorna null. Detectamos e re-tentamos
    // sem ela pra venda NUNCA parar por bug de migracao. CAPI fallback usa
    // so o que tiver disponivel.
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

// POST /api/order/:id/update — atualiza campos do pedido conforme a conversa anda
// (persistencia incremental, igual n8n). Whitelist de campos seguros — status, preco,
// midia e flags ficam SEMPRE server-side. NOVO: last_screen e events_log permitem
// crackear onde cada lead parou no quiz.
//   Requer no Supabase: ALTER TABLE orders ADD COLUMN last_screen varchar(40),
//                                          ADD COLUMN events_log text;
router.post('/api/order/:id/update', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    const b = req.body || {};
    const TEXT = {
      honoree_name: 120, customer_name: 120, relationship: 80,
      occasion: 200, story: 5000, genre: 80, mood: 80,
      voice_preference: 80, style_raw: 300,
      last_screen: 40,    // tela em que o lead esta no quiz (ex: "childOpen", "review")
      events_log: 8000,   // trilha de eventos do quiz (CSV de "step|screen|ts")
    };
    const patch = {};
    for (const k in TEXT) if (b[k] !== undefined && b[k] !== null) patch[k] = _clip(String(b[k]), TEXT[k]);
    if (b.phone !== undefined) { const p = String(b.phone || '').replace(/\D/g, '').slice(0, 15); patch.phone = p || null; }
    // Email — atualiza so se valido. Normaliza lowercase + trim.
    if (b.customer_email !== undefined || b.email !== undefined) {
      const e = String(b.customer_email || b.email || '').trim().toLowerCase().slice(0, 120);
      if (!e) patch.customer_email = null;
      else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) patch.customer_email = e;
      // email invalido — silenciosamente ignora, nao bloqueia o resto do patch
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

// POST /api/order/:id/photo — upload da FOTO do cliente (plano premium) — so
// pra pedido PAGO. Sobe no Storage e marca pra geracao do video personalizado
// (cron upsellVideo). Tambem dispara generatePersonalizedForOrder fire-and-forget.
router.post('/api/order/:id/photo', upload.single('photo'), async (req, res) => {
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
    // GERA o video PERSONALIZADO (com a foto) no proprio backend — fire-and-forget. O chat faz poll e mostra.
    try { require('../lib/brindeVideo').generatePersonalizedForOrder(id); } catch (e) { console.error('[/api/order/photo] gen falhou:', e.message); }
    res.json({ ok: true });
  } catch (e) {
    console.error('[/api/order/photo] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/order/:id/proof — upload de comprovante PIX + validacao por IA.
// Substituiu o checkout do InfinitePay (cliente paga direto na chave PIX
// e manda o comprovante aqui). A IA le o comprovante (PDF/imagem) e:
//   - se valor + beneficiario + metodo baterem com regras estritas → AUTO-APROVA
//   - se passa so parte → marca pra REVISAO MANUAL (notifica admin)
//   - se claramente nao e comprovante → REJEITA
// Camadas anti-fraude:
//   1) Tamanho ≤ 5 MB · MIME whitelist (image/* | application/pdf)
//   2) Hash SHA-256 — se ja foi usado em OUTRA order, rejeita (anti-reuso)
//   3) Idempotencia — order ja paga nao aceita novo upload
//   4) Validacao IA: valor EXATO, beneficiario contem marca, PIX, conf ≥ 0.85
//   5) Data do comprovante ≤ 72h (rejeita comprovante antigo)
//   6) Tudo registrado: proof_url, proof_hash, proof_ai_data, proof_status
//
// ⚠️  REQUER no Supabase:
//     - Bucket publico "receipts" criado em Storage.
//     - ALTER TABLE orders ADD COLUMN proof_url text,
//                          ADD COLUMN proof_hash text,
//                          ADD COLUMN proof_ai_data jsonb,
//                          ADD COLUMN proof_status varchar(30);
//     - CREATE INDEX ON orders(proof_hash);
// ═══════════════════════════════════════════════════════════════
router.post('/api/order/:id/proof', upload.single('proof'), async (req, res) => {
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
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    // Verifica se esse hash JA foi usado em OUTRA order
    const dup = await supaFetch('GET', `orders?proof_hash=eq.${hash}&id=neq.${id}&select=id,paid_at&limit=1`);
    if (Array.isArray(dup) && dup[0]) {
      console.warn('[/api/order/proof] HASH DUPLICADO:', hash.slice(0, 12), 'já em order', dup[0].id);
      return res.status(409).json({
        ok: false,
        reason: 'esse comprovante já foi enviado em outro pedido — envie o seu original',
        proof_status: 'rejected',
      });
    }

    // ── 3) Idempotencia ─────────────────────────────────────────
    const cur = await supaFetch('GET', `orders?id=eq.${id}&select=id,paid_at,status,proof_status,bill_id,phone,honoree_name,customer_name`);
    const o = Array.isArray(cur) && cur[0] ? cur[0] : null;
    if (!o) return res.status(404).json({ ok: false, reason: 'pedido não encontrado' });
    if (o.paid_at || ['paid', 'delivered'].includes((o.status || '').toLowerCase())) {
      return res.json({ ok: true, already_paid: true, proof_status: 'approved' });
    }

    // Qual plano? (preco esperado · vem do bill_id 'ip_xxx' ou default 'musica')
    // PAY_PLANS importado de lib/payPlans
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
      // segue mesmo sem URL — IA le do buffer direto
    }

    // ── 5) Validacao IA ─────────────────────────────────────────
    const { readReceipt } = require('../lib/readReceipt');
    let ai = null;
    try {
      const base64 = req.file.buffer.toString('base64');
      ai = await readReceipt({ base64, mime });
    } catch (aiErr) {
      console.error('[/api/order/proof] IA falhou:', aiErr.message);
      ai = { e_comprovante: false, erro: 'IA indisponível' };
    }

    // ── 6) Regras anti-fraude ───────────────────────────────────
    // Motivos sao strings PRONTAS pra exibir pro cliente, em pt-BR claro.
    // Cada falha aparece como item da lista no modal (rejected / review).
    const reasons = [];
    let proofStatus = 'awaiting_validation';
    let autoApprove = false;

    // ↓ helper de moeda BR · "1990" → "R$ 19,90"
    const fmtBRL = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');

    // ↓ parse de data brasileira → milissegundos UTC reais (assume horario Sao Paulo, UTC-3).
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
      // SP e UTC-3 → momento real em UTC = horario SP + 3h
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
      // — confirmacao de pagamento
      if (ai.confirma_pagamento !== true) {
        reasons.push('O comprovante não mostra o pagamento como concluído.');
      }
      // — valor
      //   • aceita: igual, MAIOR (gorjeta/arredondamento pra cima), ou
      //     ate R$ 1,00 A MENOS (apps que mostram so R$ 19 num plano de R$ 19,90).
      //   • rejeita: menos que (plano - R$ 1,00)
      //   Pra plano musica (R$ 19,90) → minimo R$ 19,00.
      //   Pra plano completa (R$ 29,90) → minimo R$ 28,90.
      const VALOR_TOLERANCIA_NEG = 1.00;            // pode pagar ate 1 real a menos
      const minAceito = +(expectedAmount - VALOR_TOLERANCIA_NEG).toFixed(2);
      let valorOk = false;
      if (typeof ai.valor_reais !== 'number') {
        reasons.push('Não conseguimos identificar o valor pago no comprovante.');
      } else if (ai.valor_reais < minAceito - 0.01) {
        // pagou MENOS que o minimo aceito → rejeita
        const falta = expectedAmount - ai.valor_reais;
        reasons.push(`O valor pago (${fmtBRL(ai.valor_reais)}) é menor que o mínimo do seu pedido (${fmtBRL(minAceito)}). Faltam ${fmtBRL(falta)}.`);
      } else {
        valorOk = true;
        // pagou menos que o plano mas dentro da tolerancia? registra pro admin saber
        if (ai.valor_reais < expectedAmount - 0.01) {
          ai._underpaid_within_tolerance = +(expectedAmount - ai.valor_reais).toFixed(2);
        }
        // pagou mais que o plano? tambem registra
        if (ai.valor_reais > expectedAmount + 0.01) {
          ai._overpaid = +(ai.valor_reais - expectedAmount).toFixed(2);
        }
      }
      // — metodo PIX
      const metodo = String(ai.metodo || '').toLowerCase();
      const pixOk = /pix/.test(metodo);
      if (!pixOk) {
        reasons.push(`O pagamento precisa ser por PIX${ai.metodo ? ` — o comprovante mostra ${ai.metodo}.` : '.'}`);
      }
      // — beneficiario (titular da conta = NIKELSON DA SILVA, CPF 131.950.597-03)
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
      // — confianca da leitura
      let confOk = true;
      if (typeof ai.confianca === 'number' && ai.confianca < 0.85) {
        confOk = false;
        reasons.push(`A leitura ficou pouco nítida (${Math.round(ai.confianca * 100)}%). Tente enviar uma imagem maior ou um PDF.`);
      }
      // — data ≤ 72h e nao no futuro (horario Sao Paulo)
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
        // tinha data mas nao conseguimos parsear — manda pra revisao manual
        reasons.push(`Não conseguimos interpretar a data do comprovante ("${ai.data}").`);
      }
      // — Decisao final
      const confirmOk = ai.confirma_pagamento === true;
      if (valorOk && pixOk && confOk && benefOk && dataOk && confirmOk && reasons.length === 0) {
        autoApprove = true;
        proofStatus = 'approved';
      } else if (confirmOk && pixOk && valorOk && dataOk) {
        // pagamento parece real (PIX + valor certo + data valida) mas algo dos
        // "suaves" falhou (beneficiario nao-encontrado, confianca baixa) — revisao.
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
      // Qualquer plano com `includes_video: true` (completa, promo_namorados_2026)
      // marca o pedido como aguardando a foto que o cliente vai mandar no
      // WhatsApp pra gerar o video personalizado. Mesma flag usada no
      // /api/pay/verify e em /api/pay/create.
      if (PAY_PLANS[plan]?.includes_video) {
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

    // ── 8) Webhooks pos-aprovacao ───────────────────────────────
    if (autoApprove) {
      if (N8N_PAY_WEBHOOK_URL) {
        try {
          await axios.post(N8N_PAY_WEBHOOK_URL,
            { event: 'billing.paid', data: { billing: { id: patch.bill_id } } },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
        } catch (e) { console.error('[/api/order/proof] webhook entrega falhou:', e.message); }
      }
      try { require('../lib/brindeVideo').generateBrindeForOrder(id); } catch (e) { console.error('[/api/order/proof] brinde gen falhou:', e.message); }
      console.log('[/api/order/proof] ✅ AUTO-APROVADO via IA:', id, '· R$', expectedAmount);
    } else if (proofStatus === 'awaiting_validation') {
      // notifica admin no WhatsApp (Evolution) com link do comprovante e razoes
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

// POST /api/order/:id/gerar_video_upsell — DISPARO IMEDIATO do video do UPSELL.
// O n8n chama isto assim que a foto chega, pra gerar+enviar NA HORA em vez de
// esperar o cron (~2min). O cron continua de backup.
router.post('/api/order/:id/gerar_video_upsell', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    res.json({ ok: true, triggered: true });  // responde rapido
    // dispara o tick do cron de upsell (processa photo_received → gera → envia no WhatsApp). fire-and-forget.
    try { require('../lib/upsellVideo').runUpsellVideoOnce('trigger-foto-' + id.slice(0, 8)); }
    catch (e) { console.error('[gerar_video_upsell] tick falhou:', e.message); }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'erro interno' });
  }
});

module.exports = router;
