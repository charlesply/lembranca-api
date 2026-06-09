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
const cronRoutes = require('./routes/cronRoutes');
const miscRoutes = require('./routes/miscRoutes');
const sunoRoutes = require('./routes/sunoRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const payRoutes = require('./routes/payRoutes');
const orderReadRoutes = require('./routes/orderReadRoutes');
const orderWriteRoutes = require('./routes/orderWriteRoutes');

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
app.use(orderWriteRoutes);

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
// /api/order POST, /:id/update, /:id/photo, /:id/proof, /:id/gerar_video_upsell extraidos pra routes/orderWriteRoutes.js na Fase F.8.b
// Helpers _isUuid e _clip viram parte das routes/orderRead+Write — server.js nao precisa mais

// Consulta pedidos por TELEFONE (cliente que voltou). Retorna os mais recentes,
// apenas colunas seguras. Tenta variantes comuns do numero (com/sem 55, com/sem 9).
// /api/order/lookup, /can_preview, /:id/status, /:id/error extraidos pra routes/orderReadRoutes.js na Fase F.8.a







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
