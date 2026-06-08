// miscRoutes — rotas utilitarias que nao se encaixam em pay/webhook/order/diag/cron.
// Quase todas sao passthrough fino pra lib/ ou servico externo (OpenAI/Inngest).
//
// Rotas (4):
//   POST /api/chat/ack            — Bia gerando reply via GPT-4o-mini
//   POST /api/generate_and_notify — dispara fila Inngest pra gerar musica
//   POST /api/regenerate          — refaz musica de UMA order (admin/n8n)
//   POST /api/read_receipt        — extrai valor/data/metodo de PDF/imagem
const express = require('express');
const axios = require('axios');

const { supaFetch } = require('../lib/supabase');
const { inngest } = require('../inngest/client');

const router = express.Router();

// POST /api/chat/ack — Bia responde com 1-2 frases curtas via GPT-4o-mini.
// Tom acolhedor, sem cliche, max 1 emoji. Se a historia veio curta (<8
// palavras) pede 1 detalhe a mais; senao, agradece citando um detalhe.
router.post('/api/chat/ack', async (req, res) => {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) return res.json({ reply: null, needMore: false });
  try {
    const b = req.body || {};
    const h = String(b.honoreeName || '').slice(0, 80);
    const rel = String(b.relationship || '').slice(0, 40);
    const st = String(b.story || '').slice(0, 2000).trim();
    const words = st ? st.split(/\s+/).length : 0;
    const tooShort = words < 8;
    const sys = 'Voce e a Bia, atendente humana e calorosa da Lembranca Cantada (musicas personalizadas feitas sob medida). '
      + 'Responda em portugues do Brasil, no maximo 2 frases curtas, tom acolhedor, natural e especifico. No maximo 1 emoji. '
      + 'Nunca invente fatos que a pessoa nao contou. Nao use cliches de marketing. '
      + (tooShort
        ? 'A historia veio curta: agradeca de leve e peca gentilmente UM detalhe a mais (um momento marcante, uma qualidade que admira, como se conheceram). Termine com uma pergunta.'
        : 'Agradeca citando 1 detalhe REAL que a pessoa contou e diga que vai caprichar na musica. Nao faca pergunta.');
    const user = `Pra quem: ${h || 'essa pessoa'} (${rel || 'sem relacao informada'}).\nHistoria contada: ${st || '(vazia)'}`;
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 130,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    const reply = r.data?.choices?.[0]?.message?.content?.trim() || null;
    res.json({ reply, needMore: tooShort });
  } catch (e) {
    console.error('[/api/chat/ack]', e.response?.data || e.message);
    res.json({ reply: null, needMore: false });
  }
});

// POST /api/generate_and_notify - Inngest: GPT lyrics -> Suno music -> Audio-Edit -> n8n webhook
// Antes: 120 linhas de fire-and-forget com variaveis globais
// Agora: inngest.send() — fila duravel com retry, concorrencia, e visibilidade
router.post('/api/generate_and_notify', async (req, res) => {
  const { prompt, story, tags, title, model, make_instrumental,
          negative_tags, phone, vocal_gender, honoreeName,
          relationship, occasion, genre, mood, voice, orderId } = req.body;

  const hasStory = story && story.trim().length > 10;
  if (!hasStory && !prompt && !tags) {
    return res.status(400).json({ error: 'Informe a historia ou ao menos prompt/tags.' });
  }

  // Marcar como generating no Supabase (feedback imediato pro frontend)
  if (orderId) {
    await supaFetch('PATCH', `orders?id=eq.${orderId}`, { status: 'generating' });
  }

  // Enviar evento pro Inngest (FILA DURAVEL com concurrency: 2)
  try {
    await inngest.send({
      name: 'song/generate.requested',
      data: {
        prompt, story, tags, title, model, make_instrumental,
        negative_tags, phone, vocal_gender, honoreeName,
        relationship, occasion, genre, mood, voice, orderId,
      },
    });
    console.log(`[Inngest] ✅ Evento enviado: song/generate.requested (order: ${orderId || 'sem'})`);
  } catch (err) {
    console.error(`[Inngest] ❌ Erro ao enviar evento:`, err.message);
    // Fallback: ainda responde 200 mas loga o erro
  }

  // Responder IMEDIATAMENTE (igual ao comportamento anterior)
  res.json({ success: true, orderId: orderId || null, status: 'generating' });
});

// POST /api/regenerate — refaz a musica de uma order (max 3 retries).
// Limpa clip IDs antigos, marca como generating, dispara Inngest com
// retryAttempt no payload (muda idempotency key).
router.post('/api/regenerate', async (req, res) => {
  const orderId = req.query.orderId || req.body.orderId;
  if (!orderId) {
    return res.status(400).json({ error: 'orderId obrigatório (query string ou body)' });
  }

  // 1. Carregar dados da order do Supabase
  const orders = await supaFetch('GET', `orders?id=eq.${orderId}&select=*`);
  if (!orders || orders.length === 0) {
    return res.status(404).json({ error: 'Order não encontrada' });
  }
  const order = orders[0];

  // Nao regenera se ja ta entregue
  if (['paid', 'delivered'].includes((order.status || '').toLowerCase())) {
    return res.status(409).json({ error: `Order já está em status '${order.status}', não pode regenerar` });
  }

  // 2. Calcular proximo retryAttempt
  const lastErr = (order.error_message || '').toLowerCase();
  const previousAttempt = parseInt((lastErr.match(/retry attempt (\d+)/) || [])[1] || 0, 10);
  const retryAttempt = previousAttempt + 1;
  const MAX_RETRIES = 3;

  if (retryAttempt > MAX_RETRIES) {
    return res.status(429).json({
      error: `Limite de ${MAX_RETRIES} retries atingido. Intervenção manual necessária.`,
      orderId, retryAttempt,
    });
  }

  // 3. Marcar como generating (volta pro estado em producao)
  await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
    status: 'generating',
    error_message: `[Regenerate retry attempt ${retryAttempt}] iniciado em ${new Date().toISOString()}`,
    // Limpa clip IDs antigos para gerar nova musica
    suno_clip_ids: null,
    original_audio_url: null,
    preview_audio_url: null,
  });

  // 4. Disparar Inngest com retryAttempt no payload (bypass idempotency)
  // Monta o estilo a partir das COLUNAS DEDICADAS (genre/mood/voice_preference/relationship),
  // com fallback no style_raw/sanitized. Inclui mood + vocals nas tags (igual ao n8n "Gera via API"),
  // senao o regenerate manda tags vazias e perde o mood/clima.
  const _voice = order.voice_preference || '';
  const _genre = order.genre || order.style_sanitized || order.style_raw || '';
  const _mood = order.mood || '';
  const _tagParts = [];
  if (_genre) _tagParts.push(_genre);
  if (_mood) _tagParts.push(_mood);
  if (/masculin|\bmale\b|homem/i.test(_voice)) _tagParts.push('male vocals');
  else if (/feminin|female|mulher/i.test(_voice)) _tagParts.push('female vocals');
  const _tags = _tagParts.join(', ');

  try {
    await inngest.send({
      name: 'song/generate.requested',
      data: {
        orderId,
        retryAttempt,  // CRITICO: muda a idempotency key
        story: order.story || '',
        honoreeName: order.honoree_name,
        relationship: order.relationship || '',
        genre: _genre,
        mood: _mood,
        voice: _voice,
        phone: order.phone,
        tags: _tags,
      },
    });
    console.log(`[Regenerate] ✅ Retry ${retryAttempt} disparado para order ${orderId}`);
  } catch (err) {
    console.error(`[Regenerate] ❌ Erro ao disparar:`, err.message);
    return res.status(500).json({ error: err.message });
  }

  res.json({
    success: true,
    orderId,
    retryAttempt,
    message: `Regeneração tentativa ${retryAttempt}/${MAX_RETRIES} disparada`,
  });
});

// POST /api/read_receipt — le comprovante (PDF/imagem) e extrai valor/data/metodo.
// Body: {base64,mime} OU {url} OU {phone,msgId}. Resolve o cliente que manda PDF do banco.
router.post('/api/read_receipt', async (req, res) => {
  try {
    const { readReceipt } = require('../lib/readReceipt');
    res.json(await readReceipt(req.body || {}));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
