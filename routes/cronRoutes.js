// cronRoutes — endpoints chamados por crons do n8n (tick manual + scheduled).
// Quase todos são `runXyzOnce('manual')` que dispara o mesmo job que o cron
// roda agendado. Sem auth pra simplificar (rede interna do Coolify).
//
// Rotas (18):
//   GET  /api/keepwarm_run         — tick Keep-Warm (renova session cookie)
//   GET  /api/upsell_video_run     — tick cron de vídeo upsell
//   GET  /api/video_brinde_run     — tick cron de vídeo brinde
//   GET  /api/monitor_run          — resumo do funil pro admin (WhatsApp)
//   GET  /api/daily_report_run     — relatório completo do dia
//   GET  /api/cleanup_run          — limpeza de mídia/mensagens >7 dias
//   GET  /api/second_version_run   — 2ª versão + indicação ~3h pós-entrega
//   POST /api/regen_and_send       — refaz/repete: cria pedido + gera + envia
//   GET  /api/preview_sender_run   — envio automático de prévia
//   GET  /api/retry_stuck_run      — retry inteligente de pedidos travados
//   GET  /api/recovery/preview     — simulação do funil de recuperação
//   GET  /api/recovery/test        — envia 1 msg recuperação (teste)
//   GET  /api/recovery/run         — funil real (com ?send=1)
//   GET  /api/leadstage/run        — recalcula lead_stage de pedidos
//   GET  /api/campaign/auto        — cadência automática de campanhas
//   GET  /api/campaign/preview     — simulação de 1 campanha
//   GET  /api/campaign/test        — envia 1 campanha real pra 1 telefone
//   GET  /api/campaign/send        — envia 1 campanha real (com max)
const express = require('express');

const router = express.Router();

// Keep-Warm REMOVIDO em 10/jun/2026 (dependia de Playwright/PlaywrightDriver).

// Upsell de vídeo personalizado
router.get('/api/upsell_video_run', async (req, res) => {
  try {
    const { runUpsellVideoOnce } = require('../lib/upsellVideo');
    res.json(await runUpsellVideoOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Vídeo brinde
router.get('/api/video_brinde_run', async (req, res) => {
  try {
    const { runVideoBrindeOnce } = require('../lib/videoBrinde');
    res.json(await runVideoBrindeOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Resumo do funil pro admin
router.get('/api/monitor_run', async (req, res) => {
  try {
    const { runSiteMonitorOnce } = require('../lib/siteMonitor');
    res.json(await runSiteMonitorOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Relatório completo do dia (?send=1 envia pro admin; sem send = só retorna texto).
// ?closeYesterday=1 ou ?yesterday=1 fecha ontem; ?today=1 força hoje.
router.get('/api/daily_report_run', async (req, res) => {
  try {
    const { runDailyReportOnce } = require('../lib/dailyReport');
    const send = req.query.send === '1' || req.query.send === 'true';
    const opts = { send };
    if (req.query.closeYesterday === '1' || req.query.yesterday === '1') opts.closeYesterday = true;
    if (req.query.today === '1') opts.closeYesterday = false;
    res.json(await runDailyReportOnce(opts));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Limpeza de mídia/mensagens >7 dias. ?dry=1 = simula SEM apagar.
router.get('/api/cleanup_run', async (req, res) => {
  try {
    const { runCleanupOnce } = require('../lib/storageCleanup');
    const dry = req.query.dry === '1' || req.query.dry === 'true';
    res.json(await runCleanupOnce('manual', dry));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 2a versão + indicação ~3h pós-entrega. ?dry=1 = só lista quem receberia.
router.get('/api/second_version_run', async (req, res) => {
  try {
    const { runSecondVersionOnce } = require('../lib/secondVersionBrinde');
    const dry = req.query.dry === '1' || req.query.dry === 'true';
    res.json(await runSecondVersionOnce('manual', dry));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Refaz/repete/grupo: cria pedido + gera + envia prévia auto.
// body: { phone, honoreeName, relationship, story, style, voice, mood }
router.post('/api/regen_and_send', async (req, res) => {
  try {
    const { regenAndSend } = require('../lib/regenPreview');
    const out = await regenAndSend(req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Envio automático de prévia (tick)
router.get('/api/preview_sender_run', async (req, res) => {
  try {
    const { runPreviewSenderOnce } = require('../lib/regenPreview');
    res.json(await runPreviewSenderOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Retry inteligente de pedidos travados (tick)
router.get('/api/retry_stuck_run', async (req, res) => {
  try {
    const { runRetryStuckOnce } = require('../lib/retryStuck');
    res.json(await runRetryStuckOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== FUNIL DE RECUPERAÇÃO (leads quentes: prévia enviada, não pago) =====
// SIMULAÇÃO (dry-run). Mostra QUEM receberia e QUAL mensagem, sem enviar.
router.get('/api/recovery/preview', async (req, res) => {
  try {
    const { runRecoveryOnce } = require('../lib/recoveryFunnel');
    const r = await runRecoveryOnce({ dryRun: true, maxPerRun: 999, onlyPhone: req.query.phone || null });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Envia a mensagem de recuperação REAL pra UM telefone (teste de 1 lead).
router.get('/api/recovery/test', async (req, res) => {
  try {
    if (!req.query.phone) return res.status(400).json({ ok: false, error: 'informe ?phone=' });
    const { runRecoveryOnce } = require('../lib/recoveryFunnel');
    const r = await runRecoveryOnce({ dryRun: false, maxPerRun: 1, onlyPhone: req.query.phone });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Roda o funil. SEM ?send=1 é SIMULAÇÃO. Com ?send=1 envia de verdade (respeita o teto).
router.get('/api/recovery/run', async (req, res) => {
  try {
    const { runRecoveryOnce } = require('../lib/recoveryFunnel');
    const r = await runRecoveryOnce({ dryRun: req.query.send !== '1' });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Recalcula o lead_stage de todos os pedidos. Seguro (só classifica).
router.get('/api/leadstage/run', async (req, res) => {
  try {
    const { runLeadStageOnce } = require('../lib/leadStage');
    res.json(await runLeadStageOnce('manual'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== CAMPANHAS AUTOMÁTICAS por estágio (cadência) + controle manual =====
// Cadência automática. SEM ?send=1 é SIMULAÇÃO.
router.get('/api/campaign/auto', async (req, res) => {
  try {
    const { runCampaignsAuto } = require('../lib/campaigns');
    res.json(await runCampaignsAuto({ dryRun: req.query.send !== '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// SIMULAÇÃO de UMA campanha (não envia).
router.get('/api/campaign/preview', async (req, res) => {
  try {
    const { runCampaign } = require('../lib/campaigns');
    res.json(await runCampaign({ campaign: req.query.campaign, dryRun: true, max: 999, all: req.query.all === '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Envia UMA campanha REAL pra 1 telefone (teste).
router.get('/api/campaign/test', async (req, res) => {
  try {
    if (!req.query.phone) return res.status(400).json({ ok: false, error: 'informe ?phone=' });
    const { runCampaign } = require('../lib/campaigns');
    res.json(await runCampaign({ campaign: req.query.campaign, dryRun: false, testPhone: req.query.phone, max: 1, all: true }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Envia UMA campanha de VERDADE (default só hoje).
router.get('/api/campaign/send', async (req, res) => {
  try {
    const { runCampaign } = require('../lib/campaigns');
    const max = req.query.max ? parseInt(req.query.max, 10) : undefined;
    res.json(await runCampaign({ campaign: req.query.campaign, dryRun: false, max, all: req.query.all === '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
