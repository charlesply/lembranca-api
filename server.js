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
const { generateLyricsWithGPT } = require('./lib/openai');
const { createPreviewFromUrl, PREVIEW_DIR, ORIGINALS_DIR, AUDIO_EDIT_URL, SELF_URL: SELF_URL_LIB } = require('./lib/audio');
const { sendPurchaseToMeta } = require('./lib/metaCapi');
const { getClient, resetClient, isAuthError } = require('./lib/suno');

// ═══ Routers extraídos (refactor Fase F) ═══
const adminRoutes = require('./routes/adminRoutes');
const diagRoutes = require('./routes/diagRoutes');

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

// Servir previews
app.get('/api/preview/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(PREVIEW_DIR, filename);
  // AUTO-CURA: o disco é efêmero (redeploy apaga). Se o arquivo sumiu, regenera da fonte (Suno CDN).
  if (!fs.existsSync(filePath)) {
    try {
      const rows = await supaFetch('GET', `orders?status=eq.preview_sent&original_audio_url=not.is.null&select=id,original_audio_url,preview_audio_url&order=created_at.desc&limit=120`);
      const o = (Array.isArray(rows) ? rows : []).find(r => (r.preview_audio_url || '').endsWith(filename));
      if (o && o.original_audio_url) {
        const title = decodeURIComponent(filename).replace(/_preview\.mp3$/i, '').replace(/_/g, ' ');
        console.log(`[Preview self-heal] regenerando ${filename} (order ${o.id})`);
        await createPreviewFromUrl(o.original_audio_url, o.id, title);
      }
    } catch (e) { console.error('[Preview self-heal] falhou:', e.message); }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preview nao encontrado.' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `inline; filename="${decodeURIComponent(filename)}"`);
  fs.createReadStream(filePath).pipe(res);
});

// Servir originais
app.get('/api/original/:filename', (req, res) => {
  const filePath = path.join(ORIGINALS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Original nao encontrado.' });
  res.setHeader('Content-Type', 'audio/mpeg');
  const friendlyName = decodeURIComponent(req.params.filename);
  res.setHeader('Content-Disposition', `attachment; filename="${friendlyName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// PROXY DE DOWNLOAD — força o download (Content-Disposition: attachment) de arquivos remotos.
// Resolve o problema do iOS/mobile que ignora o atributo download em links cross-origin (toca em vez de baixar).
app.get('/api/download', async (req, res) => {
  try {
    const url = (req.query.url || '').toString();
    let name = (req.query.name || 'arquivo').toString().replace(/[^a-zA-Z0-9._ ()-]/g, '').slice(0, 80) || 'arquivo';
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return res.status(400).json({ error: 'url invalida' }); }
    // whitelist de hosts (anti-SSRF / open-proxy)
    const ok = host.endsWith('.suno.ai') || host.endsWith('.supabase.co') || host.endsWith('.linkarbox.app') || host === 'cdn1.suno.ai' || host === 'cdn2.suno.ai';
    if (!ok) return res.status(403).json({ error: 'host nao permitido' });
    const upstream = await axios.get(url, { responseType: 'stream', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity });
    const ct = upstream.headers['content-type'] || (/\.mp4$/i.test(name) ? 'video/mp4' : 'audio/mpeg');
    if (!/\.(mp3|mp4|wav|m4a)$/i.test(name)) name += /video/i.test(ct) ? '.mp4' : '.mp3';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.pipe(res);
  } catch (e) {
    console.error('[/api/download] erro:', e.message);
    res.status(502).json({ error: 'falha no download' });
  }
});

// Rotas de diagnóstico/debug (/api/diag, /api/test-client, /api/test-preview,
// /api/playwright_*, /api/keepwarm_test, /api/active_cookie) extraídas pra
// routes/diagRoutes.js na Fase F.2

// GET /api/keepwarm_run — forca um tick do Keep-Warm e SALVA na tabela suno_session.
// Usado pra validar a Fase 2b (cron salvando). Aditivo: ninguem consome a tabela ainda.
app.get('/api/keepwarm_run', async (req, res) => {
  try {
    const { runKeepWarmOnce } = require('./lib/keepWarm');
    const r = await runKeepWarmOnce('manual');
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/upsell_video_run — forca um tick do cron de video personalizado (upsell).
app.get('/api/upsell_video_run', async (req, res) => {
  try {
    const { runUpsellVideoOnce } = require('./lib/upsellVideo');
    res.json(await runUpsellVideoOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/video_brinde_run — forca um tick do cron de video de brinde (pra validar/testar).
app.get('/api/video_brinde_run', async (req, res) => {
  try {
    const { runVideoBrindeOnce } = require('./lib/videoBrinde');
    res.json(await runVideoBrindeOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/monitor_run — força um resumo do funil do site pro admin (pra testar na hora).
app.get('/api/monitor_run', async (req, res) => {
  try {
    const { runSiteMonitorOnce } = require('./lib/siteMonitor');
    res.json(await runSiteMonitorOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/daily_report_run?send=1 — relatorio completo do dia (Brasilia). send=1 envia pro admin; sem send = so retorna o texto.
app.get('/api/daily_report_run', async (req, res) => {
  try {
    const { runDailyReportOnce } = require('./lib/dailyReport');
    const send = req.query.send === '1' || req.query.send === 'true';
    const opts = { send };
    if (req.query.closeYesterday === '1' || req.query.yesterday === '1') opts.closeYesterday = true;
    if (req.query.today === '1') opts.closeYesterday = false;
    const r = await runDailyReportOnce(opts);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /api/admin_command e /api/admin/* extraídos pra routes/adminRoutes.js na Fase F.1
// GET /api/cleanup_run?dry=1 — limpeza de midia/mensagens >7 dias. dry=1 = simula SEM apagar.
app.get('/api/cleanup_run', async (req, res) => {
  try {
    const { runCleanupOnce } = require('./lib/storageCleanup');
    const dry = req.query.dry === '1' || req.query.dry === 'true';
    res.json(await runCleanupOnce('manual', dry));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/second_version_run?dry=1 — 2a versao + indicacao ~3h pos-entrega. dry=1 = so lista quem receberia.
app.get('/api/second_version_run', async (req, res) => {
  try {
    const { runSecondVersionOnce } = require('./lib/secondVersionBrinde');
    const dry = req.query.dry === '1' || req.query.dry === 'true';
    res.json(await runSecondVersionOnce('manual', dry));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/regen_and_send — refaz/repete/grupo: cria pedido + gera + envia previa auto.
// body: { phone, honoreeName, relationship, story, style, voice, mood }
app.post('/api/regen_and_send', async (req, res) => {
  try {
    const { regenAndSend } = require('./lib/regenPreview');
    const out = await regenAndSend(req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// GET /api/preview_sender_run — forca um tick do envio automatico de previa (testar).
app.get('/api/preview_sender_run', async (req, res) => {
  try {
    const { runPreviewSenderOnce } = require('./lib/regenPreview');
    res.json(await runPreviewSenderOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/retry_stuck_run — forca um tick do retry inteligente (pra validar/testar).
app.get('/api/retry_stuck_run', async (req, res) => {
  try {
    const { runRetryStuckOnce } = require('./lib/retryStuck');
    const r = await runRetryStuckOnce('manual');
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== FUNIL DE RECUPERAÇÃO (leads quentes: prévia enviada, não pago) =====
// GET /api/recovery/preview — SIMULAÇÃO (dry-run). Mostra QUEM receberia e QUAL mensagem, sem enviar nada.
app.get('/api/recovery/preview', async (req, res) => {
  try {
    const { runRecoveryOnce } = require('./lib/recoveryFunnel');
    const r = await runRecoveryOnce({ dryRun: true, maxPerRun: 999, onlyPhone: req.query.phone || null });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/recovery/test?phone=XXXX — envia a mensagem de recuperação REAL pra UM telefone (teste de 1 lead).
app.get('/api/recovery/test', async (req, res) => {
  try {
    if (!req.query.phone) return res.status(400).json({ ok: false, error: 'informe ?phone=' });
    const { runRecoveryOnce } = require('./lib/recoveryFunnel');
    const r = await runRecoveryOnce({ dryRun: false, maxPerRun: 1, onlyPhone: req.query.phone });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/recovery/run — roda o funil. SEM ?send=1 é SIMULAÇÃO. Com ?send=1 envia de verdade (respeita o teto).
app.get('/api/recovery/run', async (req, res) => {
  try {
    const { runRecoveryOnce } = require('./lib/recoveryFunnel');
    const r = await runRecoveryOnce({ dryRun: req.query.send !== '1' });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/leadstage/run — recalcula o lead_stage de todos os pedidos (manual). Seguro (só classifica).
app.get('/api/leadstage/run', async (req, res) => {
  try {
    const { runLeadStageOnce } = require('./lib/leadStage');
    res.json(await runLeadStageOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== CAMPANHAS AUTOMÁTICAS por estágio (cadência) + controle manual =====
// GET /api/campaign/auto?dry=1 — roda a cadência automática. SEM ?send=1 é SIMULAÇÃO.
app.get('/api/campaign/auto', async (req, res) => {
  try {
    const { runCampaignsAuto } = require('./lib/campaigns');
    res.json(await runCampaignsAuto({ dryRun: req.query.send !== '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/campaign/preview?campaign=promo[&all=1] — SIMULAÇÃO de UMA campanha (não envia).
app.get('/api/campaign/preview', async (req, res) => {
  try {
    const { runCampaign } = require('./lib/campaigns');
    res.json(await runCampaign({ campaign: req.query.campaign, dryRun: true, max: 999, all: req.query.all === '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/campaign/test?campaign=X&phone=Y — envia UMA campanha REAL pra 1 telefone (teste).
app.get('/api/campaign/test', async (req, res) => {
  try {
    if (!req.query.phone) return res.status(400).json({ ok: false, error: 'informe ?phone=' });
    const { runCampaign } = require('./lib/campaigns');
    res.json(await runCampaign({ campaign: req.query.campaign, dryRun: false, testPhone: req.query.phone, max: 1, all: true }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/campaign/send?campaign=X&max=N[&all=1] — envia UMA campanha de VERDADE (default só hoje).
app.get('/api/campaign/send', async (req, res) => {
  try {
    const { runCampaign } = require('./lib/campaigns');
    const max = req.query.max ? parseInt(req.query.max, 10) : undefined;
    res.json(await runCampaign({ campaign: req.query.campaign, dryRun: false, max, all: req.query.all === '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/read_receipt — lê comprovante de pagamento (PDF/imagem) e extrai valor/data/método.
// Body: {base64,mime} OU {url} OU {phone,msgId}. Resolve o cliente que manda PDF do banco.
app.post('/api/read_receipt', async (req, res) => {
  try {
    const { readReceipt } = require('./lib/readReceipt');
    res.json(await readReceipt(req.body || {}));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /api/cookie_health extraído pra routes/diagRoutes.js na Fase F.2

// GET /api/get_limit
app.get('/api/get_limit', async (req, res) => {
  try {
    const c = await getClient();
    res.json(await c.getLimit());
  } catch (err) {
    console.error('[/api/get_limit]', err.message);
    if (isAuthError(err.message)) resetClient();
    res.status(500).json({ error: err.message });
  }
});

// POST /api/custom_generate
app.post('/api/custom_generate', async (req, res) => {
  try {
    const c = await getClient();
    const { prompt, tags, title, model, make_instrumental, negative_tags, wait_audio } = req.body;
    res.json(await c.customGenerate({ prompt, tags, title, model, make_instrumental, negative_tags, wait_audio }));
  } catch (err) {
    // DEBUG: expor detalhes completos do erro do Suno
    const sunoStatus = err.response?.status;
    const sunoData = err.response?.data;
    console.error('[/api/custom_generate]', err.message, 'sunoStatus:', sunoStatus, 'sunoData:', JSON.stringify(sunoData).substring(0, 500));
    if (isAuthError(err.message)) { resetClient(); res.status(401).json({ error: 'Cookie expirado.' }); }
    else res.status(500).json({
      error: err.message,
      suno_status: sunoStatus,
      suno_error_type: sunoData?.error_type,
      suno_detail: sunoData?.detail,
      suno_data: sunoData,
    });
  }
});

// POST /api/generate
app.post('/api/generate', async (req, res) => {
  try {
    const c = await getClient();
    const { prompt, model, make_instrumental, wait_audio } = req.body;
    res.json(await c.generate({ prompt, model, make_instrumental, wait_audio }));
  } catch (err) {
    console.error('[/api/generate]', err.message);
    if (isAuthError(err.message)) resetClient();
    res.status(500).json({ error: err.message });
  }
});

// GET /api/get?ids=xxx,yyy
app.get('/api/get', async (req, res) => {
  try {
    const c = await getClient();
    res.json(await c.getClips(req.query.ids || ''));
  } catch (err) {
    console.error('[/api/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transcribe - Whisper audio transcription
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo de audio enviado.' });
  const buf = req.file.buffer;
  const mime = req.file.mimetype || 'audio/webm';
  console.log(`[Transcribe] ${(buf.length / 1024).toFixed(0)}KB ${mime}`);

  // 1) AssemblyAI (primario \u2014 igual ao n8n/site antigo, melhor p/ PT)
  const AAI = process.env.ASSEMBLYAI_API_KEY || '';
  if (AAI) {
    try {
      const up = await axios.post('https://api.assemblyai.com/v2/upload', buf, {
        headers: { Authorization: AAI, 'Content-Type': 'application/octet-stream' },
        timeout: 60000, maxBodyLength: Infinity, maxContentLength: Infinity,
      });
      const upUrl = up.data && up.data.upload_url;
      if (!upUrl) throw new Error('sem upload_url');
      const sub = await axios.post('https://api.assemblyai.com/v2/transcript',
        { audio_url: upUrl, language_code: 'pt', speech_models: ['universal-3-pro'] },
        { headers: { Authorization: AAI, 'Content-Type': 'application/json' }, timeout: 30000 });
      const id = sub.data && sub.data.id;
      if (!id) throw new Error('sem id');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const pr = await axios.get('https://api.assemblyai.com/v2/transcript/' + id, { headers: { Authorization: AAI }, timeout: 10000 });
        if (pr.data && pr.data.status === 'completed') {
          const text = (pr.data.text || '').trim();
          console.log(`[Transcribe] \u2705 AssemblyAI (${text.length} chars)`);
          return res.json({ text, provider: 'assemblyai' });
        }
        if (pr.data && pr.data.status === 'error') throw new Error(pr.data.error || 'aai error');
      }
      throw new Error('assemblyai timeout');
    } catch (e) {
      console.error('[Transcribe] AssemblyAI falhou, fallback Whisper:', e.response?.data || e.message);
    }
  }

  // 2) Whisper (fallback)
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'transcricao indisponivel' });
  try {
    const form = new FormData();
    form.append('file', buf, { filename: 'audio.webm', contentType: mime });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    form.append('response_format', 'text');
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      timeout: 60000, maxContentLength: 30 * 1024 * 1024,
    });
    const text = typeof resp.data === 'string' ? resp.data.trim() : resp.data.text?.trim() || '';
    console.log(`[Transcribe] \u2705 Whisper (${text.length} chars)`);
    res.json({ text, provider: 'whisper' });
  } catch (err) {
    console.error('[/api/transcribe]', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha na transcricao: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// POST /api/chat/ack — a Bia "entende" a historia (texto livre) e responde calorosa.
// Se a historia ficou curta, pede gentilmente mais 1 detalhe. GPT server-side (chave
// nunca exposta). Se falhar/sem chave, devolve {reply:null} e o front usa o fluxo canned.
app.post('/api/chat/ack', async (req, res) => {
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
// Antes: 120 linhas de fire-and-forget com variáveis globais
// Agora: inngest.send() — fila durável com retry, concorrência, e visibilidade
app.post('/api/generate_and_notify', async (req, res) => {
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

  // Enviar evento pro Inngest (FILA DURÁVEL com concurrency: 2)
  try {
    await inngest.send({
      name: 'song/generate.requested',
      data: {
        prompt, story, tags, title, model, make_instrumental,
        negative_tags, phone, vocal_gender, honoreeName,
        relationship, occasion, genre, mood, voice, orderId,
      },
    });
    console.log(`[Inngest] \u2705 Evento enviado: suno/generate.requested (order: ${orderId || 'sem'})`);
  } catch (err) {
    console.error(`[Inngest] \u274c Erro ao enviar evento:`, err.message);
    // Fallback: ainda responde 200 mas loga o erro
  }

  // Responder IMEDIATAMENTE (igual ao comportamento anterior)
  res.json({ success: true, orderId: orderId || null, status: 'generating' });
});

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
app.get('/api/order/lookup', async (req, res) => {
  try {
    const raw = (req.query.phone || '').toString().replace(/\D/g, '').slice(0, 15);
    if (raw.length < 10) return res.status(400).json({ error: 'phone invalido' });
    const variants = new Set([raw]);
    if (raw.startsWith('55')) variants.add(raw.slice(2)); else variants.add('55' + raw);
    // variante sem o 9 do celular (DDD + 9 + 8 digitos) e com o 9
    const m = raw.replace(/^55/, '');
    if (m.length === 11 && m[2] === '9') variants.add((raw.startsWith('55') ? '55' : '') + m.slice(0, 2) + m.slice(3));
    if (m.length === 10) variants.add((raw.startsWith('55') ? '55' : '') + m.slice(0, 2) + '9' + m.slice(2));
    const cols = 'id,status,honoree_name,customer_name,preview_audio_url,original_audio_url,video_brinde_url,paid_at,created_at';
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

// RATE LIMIT: cada número pode ter só 1 prévia NÃO-paga por 24h.
// Pra pedir outra música, precisa pagar a prévia pendente. Retorna o pedido que está bloqueando.
app.get('/api/order/can_preview', async (req, res) => {
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
        // prefere um com prévia pronta
        if (!pend || (o.status === 'preview_sent' && o.preview_audio_url)) pend = o;
      }
    }
    if (pend) return res.json({ blocked: true, order: pend });
    res.json({ blocked: false });
  } catch (e) {
    console.error('[/api/order/can_preview] erro:', e.message);
    res.json({ blocked: false }); // em erro, não bloqueia (fail-open)
  }
});

// Consulta status do pedido (apenas colunas seguras; exige o UUID exato)
app.get('/api/order/:id/status', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    const cols = 'status,preview_audio_url,original_audio_url,full_audio_urls,client_contacted_at,error_message,final_lyrics,video_brinde_url,video_upsell_status,honoree_name,customer_name,phone,paid_at';
    const rows = await supaFetch('GET', `orders?id=eq.${id}&select=${cols}`);
    if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: 'nao encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[/api/order status] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

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

// Marca pedido como erro (front chama no catch). PATCH so server-side.
app.post('/api/order/:id/error', async (req, res) => {
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
// depois de uma rejeição. Salva timestamp no proof_ai_data pra histórico e
// avisa o admin no WhatsApp imediatamente (pra ela já abrir o chat sabendo).
app.post('/api/order/:id/help_request', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ ok: false, reason: 'id invalido' });
    const reasons = Array.isArray(req.body?.reasons) ? req.body.reasons.slice(0, 8) : [];
    const ctx = String(req.body?.context || 'rejected').slice(0, 40);

    // Busca dados do pedido pra montar a notificação rica
    const rows = await supaFetch('GET',
      `orders?id=eq.${id}&select=id,honoree_name,customer_name,phone,proof_ai_data,proof_status,paid_at,created_at`);
    const o = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!o) return res.status(404).json({ ok: false, reason: 'pedido nao encontrado' });

    // Persiste o ping no proof_ai_data (pra historial). Append-only.
    try {
      const cur = o.proof_ai_data || {};
      const helps = Array.isArray(cur.help_requests) ? cur.help_requests : [];
      helps.push({ at: new Date().toISOString(), context: ctx, reasons });
      cur.help_requests = helps.slice(-10);  // mantém só os 10 últimos
      await supaFetch('PATCH', `orders?id=eq.${id}`, { proof_ai_data: cur });
    } catch (e) { console.error('[/help_request] persist falhou:', e.message); }

    // Avisa o admin no WhatsApp via Evolution (mesmo canal usado nos comprovantes)
    try {
      const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
      const EVO_KEY = process.env.EVO_KEY || '';
      const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
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

// ═══════════════════════════════════════════════════════════════════════════
// Webhook callback do sunoapi.org. É chamado em 4 momentos:
//   • text     — lyrics geradas (não usamos, já temos GPT)
//   • first    — primeira faixa pronta (latência mais baixa)
//   • complete — todas as faixas prontas
//   • error    — geração falhou
//
// IMPORTANTE: o polling do Inngest é AUTORITATIVO. Este webhook é só
// observabilidade — loga + persiste o último estado pra debug. Não dispara
// entrega (o pipeline durável já cuida disso). Responde 200 SEMPRE pra evitar
// retry desnecessário do sunoapi.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/webhooks/sunoapi', express.json({ limit: '2mb' }), async (req, res) => {
  res.json({ ok: true });  // ack imediato pro sunoapi não retry
  try {
    const body = req.body || {};
    const taskId = body.data?.task_id || body.data?.taskId || null;
    const callbackType = body.data?.callbackType || 'unknown';
    const code = body.code;
    const tracks = Array.isArray(body.data?.data) ? body.data.data : [];
    console.log(`[sunoapi/webhook] type=${callbackType} code=${code} task=${taskId?.slice(0,12)} tracks=${tracks.length}`);

    if (!taskId) return;

    // Acha o order pelo taskId
    const rows = await supaFetch('GET', `orders?suno_task_id=eq.${taskId}&select=id,status`);
    const o = Array.isArray(rows) && rows[0];
    if (!o) {
      console.warn(`[sunoapi/webhook] taskId ${taskId.slice(0,12)} sem order — ignorando`);
      return;
    }

    // Snapshot de observabilidade no error_message (campo livre pra rastro)
    const snapshot = `[sunoapi/${callbackType}] code=${code} tracks=${tracks.length} t=${new Date().toISOString().slice(0,19)}`;
    const patch = { error_message: snapshot.slice(0, 500) };

    // À PROVA DE FALHAS: se este callback tem tracks com audioUrl OU clip ID,
    // já salva no DB AGORA. Antes esse handler só fazia observabilidade e
    // dependia do Inngest pra preencher — quando o Inngest falhava em ler o
    // status (Suno API mente FAILED), a order ficava sem URL eternamente.
    //
    // Construir cdn1.suno.ai/{id}.mp3 a partir do clip ID é DETERMINÍSTICO:
    // sempre funciona se a música foi de fato gerada (testado historicamente).
    if (tracks.length && (callbackType === 'complete' || callbackType === 'first')) {
      try {
        const { tracksToUrls } = require('./lib/sunoFallback');
        const { urls, ids } = tracksToUrls(tracks);
        if (urls.length) {
          patch.full_audio_urls = urls;
          patch.original_audio_url = urls[0];
        }
        if (ids.length) patch.suno_clip_ids = ids;
        console.log(`[sunoapi/webhook] 💾 ${o.id.slice(0,8)} salvando ${urls.length} URL(s) + ${ids.length} clipId(s)`);
      } catch (e) {
        console.error('[sunoapi/webhook] falha em extrair URLs:', e.message);
      }
    }

    await supaFetch('PATCH', `orders?id=eq.${o.id}`, patch);
  } catch (e) {
    console.error('[sunoapi/webhook] erro (não-fatal):', e.message);
  }
});

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

// ═══════════════════════════════════════════════════════════════
// PAGAMENTO — InfinitePay Checkout (site). Fluxo:
//  1) front chama POST /api/pay/create  -> devolve a URL do checkout
//  2) cliente paga no InfinitePay e volta pro site (redirect_url)
//  3) front chama POST /api/pay/verify com {orderId, transaction_nsu, slug}
//     -> backend confirma no payment_check do InfinitePay e marca PAGO.
//     -> (entrega da musica completa/video reusa o caminho do n8n).
// ADITIVO: nao altera nada do fluxo existente. Gated por INFINITEPAY_HANDLE.
// ═══════════════════════════════════════════════════════════════
const INFINITEPAY_HANDLE = process.env.INFINITEPAY_HANDLE || '';
const SITE_URL = process.env.SITE_URL || 'https://historiascantadas.linkarbox.app';
const N8N_PAY_WEBHOOK_URL = process.env.N8N_PAY_WEBHOOK_URL || ''; // opcional: dispara a entrega do n8n

// PLANOS com PREÇO FIXO NO SERVIDOR (cliente NAO consegue alterar o valor —
// o front só manda o identificador do plano, quem decide o preço é o backend).
const PAY_PLANS = {
  musica:      { cents: 1990, name: 'Musica personalizada - Lembranca Cantada' },
  completa:    { cents: 2990, name: 'Musica + Video personalizado com foto - Lembranca Cantada' },
  // legado (nao ofertado no site novo, mantido por compatibilidade de links antigos)
  video_letra: { cents: 2990, name: 'Musica + Video personalizado com foto - Lembranca Cantada' },
};

// ═══════════════════════════════════════════════════════════════
// PAGAMENTO via AbacatePay — gera PIX dinâmico com confirmação automática
// (substitui InfinitePay que era do amigo)
// ═══════════════════════════════════════════════════════════════
const ABACATEPAY_API_KEY = process.env.ABACATEPAY_API_KEY || '';
const ABACATEPAY_API = 'https://api.abacatepay.com/v2';

app.post('/api/pay/create', async (req, res) => {
  try {
    if (!ABACATEPAY_API_KEY) return res.status(503).json({ error: 'AbacatePay nao configurado (ABACATEPAY_API_KEY)' });
    const { orderId, plan } = req.body || {};
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'orderId invalido' });
    const p = PAY_PLANS[plan];
    if (!p) return res.status(400).json({ error: 'plano invalido' });
    const cents = p.cents;

    // SEMPRE cria PIX novo com externalId único — evita dedup do AbacatePay
    // (que retornava cobrança antiga com valor errado quando o cliente trocava plano)
    const extId = `${orderId}-${plan}-${Math.floor(Date.now() / 1000)}`;

    // Cria cobrança PIX na AbacatePay
    const ar = await axios.post(`${ABACATEPAY_API}/transparents/create`, {
      method: 'PIX',
      data: {
        amount: cents,
        expiresIn: 60 * 60, // 1h
        description: p.name,
        externalId: extId,
        metadata: { order_id: orderId, plan },
      },
    }, {
      headers: { Authorization: `Bearer ${ABACATEPAY_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });

    const data = ar.data?.data;
    if (!data?.id || !data?.brCode) {
      console.error('[/api/pay/create] resposta inesperada:', ar.data);
      return res.status(502).json({ error: 'falha ao gerar PIX' });
    }

    console.log('[/api/pay/create] AbacatePay PIX criado:', data.id, 'p/', orderId, '(', cents, 'cents)');

    // grava na order pra webhook + polling acharem
    const patchPay = {
      bill_id: data.id,
      abacate_charge_id: data.id,
      abacate_brcode: data.brCode,
      abacate_qrcode: data.brCodeBase64,
      abacate_status: 'PENDING',
      payment_method: 'pix',
      payment_amount: cents / 100,
      plan,
    };
    if (plan === 'completa') patchPay.video_upsell_status = 'pending_photo';
    try { await supaFetch('PATCH', `orders?id=eq.${orderId}`, patchPay); } catch (e) { console.error('[/api/pay/create] patch err:', e.message); }

    res.json({
      ok: true,
      paymentId: data.id,
      brCode: data.brCode,
      brCodeBase64: data.brCodeBase64,
      amount: cents,
      expiresAt: data.expiresAt,
    });
  } catch (e) {
    console.error('[/api/pay/create] erro:', e.response?.data || e.message);
    res.status(500).json({ error: 'erro interno', detail: String(e.response?.data?.error || e.message) });
  }
});

// Status do pagamento — frontend faz polling pra detectar quando paga
app.get('/api/pay/status', async (req, res) => {
  try {
    const orderId = req.query.orderId;
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'orderId invalido' });
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=status,abacate_status,abacate_charge_id`);
    const o = rows?.[0];
    if (!o) return res.status(404).json({ error: 'nao encontrado' });
    const paid = o.status === 'paid' || o.status === 'delivered' || o.abacate_status === 'PAID';
    res.json({ ok: true, paid, status: o.status, abacate_status: o.abacate_status });
  } catch (e) {
    res.status(500).json({ error: 'erro interno' });
  }
});

// Webhook da AbacatePay — confirmação automática quando cliente paga
app.post('/api/webhooks/abacatepay', async (req, res) => {
  try {
    const expected = process.env.ABACATEPAY_WEBHOOK_SECRET;
    if (!expected) return res.status(500).json({ error: 'webhook nao configurado' });
    const recv = req.headers['x-abacatepay-secret'] || req.headers['abacatepay-secret'] || req.query.webhookSecret;
    if (recv !== expected) return res.status(401).json({ error: 'unauthorized' });

    const event = req.body?.event;
    const data = req.body?.data;
    console.log('[webhook abacatepay] RAW:', JSON.stringify(req.body));

    if (event === 'transparent.completed' || event === 'checkout.completed' || event === 'billing.paid' || event === 'paid') {
      // AbacatePay manda estrutura variável — tentamos várias chaves
      const transparent = data?.transparent || data?.checkout || data?.charge || data?.pixQrCode || data;
      const externalId = transparent?.externalId || data?.externalId;
      const paymentId = transparent?.id || data?.id;
      // Resolução do orderId — ordem de prioridade:
      //   1) metadata.order_id (V2 — mais confiável; SEMPRE vem quando criamos via
      //      /api/pay/create porque passamos metadata={order_id, plan})
      //   2) externalId no formato "{uuid}-{plan}-{ts}" (legado)
      //   3) abacate_charge_id no DB (último recurso — pode falhar se PIX foi
      //      renovado e a charge atual difere da salva)
      // BUG corrigido: antes só olhávamos externalId. Quando AbacatePay V2 manda
      // externalId=null (caso da Maria luana 07/06 — order 7756cae8), o parse
      // falhava silenciosamente e a order ficava preview_sent pra sempre, mesmo
      // com pagamento confirmado no AbacatePay.
      const metadataOrderId = transparent?.metadata?.order_id || data?.metadata?.order_id;
      const m = externalId && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(externalId);
      const orderId = metadataOrderId || m?.[1];
      console.log('[webhook abacatepay] parsed orderId:', orderId, '(src:', metadataOrderId ? 'metadata' : (m ? 'externalId' : 'fallback-paymentId'), ') paymentId:', paymentId);
      const filter = orderId ? `id=eq.${orderId}` : `abacate_charge_id=eq.${paymentId}`;
      const rows = await supaFetch('GET', `orders?${filter}&select=id,status`);
      const o = rows?.[0];
      if (!o) return res.json({ ok: true, found: false });
      if (o.status === 'paid' || o.status === 'delivered') return res.json({ ok: true, already: true });
      await supaFetch('PATCH', `orders?id=eq.${o.id}`, {
        status: 'paid',
        abacate_status: 'PAID',
        paid_at: new Date().toISOString(),
      });
      console.log('[webhook abacatepay] order', o.id, 'PAID');
      // dispara entrega via brindeVideo cron quando necessário
      try { require('./lib/brindeVideo').generateBrindeForOrder(o.id); } catch (_) {}
      // Email transacional de entrega — fire-and-forget. Se falhar aqui, o cron
      // emailDeliveryMonitor pega no próximo tick (a cada 10 min).
      // Carrega dados completos pra o template + lib.
      try {
        const emailRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,honoree_name,customer_name,customer_email,plan,original_audio_url,full_audio_urls,video_brinde_url,email_delivery_sent`);
        const emailOrder = emailRows?.[0];
        if (emailOrder && emailOrder.customer_email && !emailOrder.email_delivery_sent) {
          require('./lib/emailDelivery').sendDeliveryEmail(emailOrder).catch(e => {
            console.error('[webhook abacatepay] email delivery falhou (ignorado, cron tenta de novo):', e.message);
          });
        }
      } catch (e) {
        console.error('[webhook abacatepay] erro ao buscar pra email (ignorado):', e.message);
      }
      // Meta Conversions API (CAPI) — envio server-side garantido, dedup com client-side via event_id
      try {
        let fullRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,customer_name,customer_email,phone,payment_amount,plan,fbp_pixel_id,fbp,fbc,client_ip,client_user_agent,meta_capi_sent,paid_at`);
        // Fallback: se a coluna customer_email ainda não existir, refaz sem ela
        if (!Array.isArray(fullRows) || !fullRows[0]) {
          fullRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,customer_name,phone,payment_amount,plan,fbp_pixel_id,fbp,fbc,client_ip,client_user_agent,meta_capi_sent,paid_at`);
        }
        const fullOrder = fullRows?.[0];
        if (fullOrder && !fullOrder.meta_capi_sent) {
          const result = await sendPurchaseToMeta(fullOrder);
          if (result?.ok) {
            await supaFetch('PATCH', `orders?id=eq.${o.id}`, { meta_capi_sent: true });
          }
        }
      } catch (e) {
        console.error('[webhook abacatepay] CAPI falhou (ignorado):', e.message);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook abacatepay] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// Valida o pagamento no InfinitePay e marca o pedido como pago
app.post('/api/pay/verify', async (req, res) => {
  try {
    if (!INFINITEPAY_HANDLE) return res.status(503).json({ error: 'pagamento ainda nao configurado (handle)' });
    const { orderId, transaction_nsu, slug } = req.body || {};
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'orderId invalido' });
    if (!transaction_nsu || !slug) return res.status(400).json({ error: 'transaction_nsu/slug obrigatorios' });

    // Confirma no InfinitePay (server-side; cliente nao consegue forjar)
    let chk = null;
    try {
      const r = await axios.post('https://api.checkout.infinitepay.io/payment_check',
        { handle: INFINITEPAY_HANDLE, order_nsu: orderId, transaction_nsu, slug },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      chk = r.data;
    } catch (e) { chk = { success: false, error: e.response?.data || e.message }; }

    const paid = !!(chk && (chk.paid === true || (chk.success === true && chk.paid !== false)));
    if (!paid) return res.json({ ok: true, paid: false, detail: chk });

    // Idempotente: se ja estava pago, nao reprocessa (evita entrega dupla no reload)
    const cur = await supaFetch('GET', `orders?id=eq.${orderId}&select=status,paid_at,original_audio_url,full_audio_urls`);
    const o = Array.isArray(cur) && cur[0] ? cur[0] : null;
    const already = o && (o.paid_at || ['paid', 'delivered'].includes((o.status || '').toLowerCase()));
    if (o && !already) {
      // garante full_audio_urls (a entrega do n8n manda full_audio_urls[0]/[1])
      let fau = Array.isArray(o.full_audio_urls) ? o.full_audio_urls.filter(Boolean) : [];
      if (!fau.length && o.original_audio_url) fau = [o.original_audio_url];
      const patch = {
        status: 'paid', paid_at: new Date().toISOString(),
        payment_method: 'infinitepay', payment_amount: (chk.paid_amount || chk.amount || null),
        bill_id: 'ip_' + orderId,
      };
      if (fau.length) patch.full_audio_urls = fau;
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, patch);
      // Dispara a ENTREGA reusando o webhook que JA entrega (formato AbacatePay):
      // ele acha o pedido por bill_id e manda a musica completa + marca entregue.
      if (N8N_PAY_WEBHOOK_URL) {
        try {
          await axios.post(N8N_PAY_WEBHOOK_URL,
            { event: 'billing.paid', data: { billing: { id: 'ip_' + orderId } } },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
        } catch (e) { console.error('[/api/pay/verify] webhook entrega falhou:', e.message); }
      }
      // GERA o vídeo de brinde no PRÓPRIO backend (independente do n8n) — fire-and-forget
      try { require('./lib/brindeVideo').generateBrindeForOrder(orderId); } catch (e) { console.error('[/api/pay/verify] brinde gen falhou:', e.message); }
      console.log('[/api/pay/verify] ✅ PAGO + entrega disparada:', orderId);
    }
    res.json({ ok: true, paid: true });
  } catch (e) {
    console.error('[/api/pay/verify] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// POST /api/regenerate?orderId=X — Retenta produção de uma order que falhou
// Usa idempotency_attempt único pra Inngest aceitar (bypass do 24h dedup)
app.post('/api/regenerate', async (req, res) => {
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

  // Não regenera se já tá entregue
  if (['paid', 'delivered'].includes((order.status || '').toLowerCase())) {
    return res.status(409).json({ error: `Order já está em status '${order.status}', não pode regenerar` });
  }

  // 2. Calcular próximo retryAttempt
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

  // 3. Marcar como generating (volta pro estado em produção)
  await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
    status: 'generating',
    error_message: `[Regenerate retry attempt ${retryAttempt}] iniciado em ${new Date().toISOString()}`,
    // Limpa clip IDs antigos para gerar nova música
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
        retryAttempt,  // CRÍTICO: muda a idempotency key
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
