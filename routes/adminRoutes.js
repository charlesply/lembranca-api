// adminRoutes — rotas administrativas, todas com proteção por secret.
// Montadas no server.js raiz (sem prefixo); cada rota traz seu /api/...
//
// Auth: header/query `secret` deve bater com ADMIN_API_SECRET ou (fallback)
// ABACATEPAY_WEBHOOK_SECRET. Sem secret configurado = 401 sempre.
//
// Rotas:
//   POST /api/admin_command          — comandos do admin via WhatsApp
//   GET  /api/admin/suno_monitor_run — varredura manual do Suno monitor
//   GET  /api/admin/suno_rescue      — fallback pra UMA order específica
//   GET  /api/admin/capi_monitor_run — varredura manual do CAPI monitor
//   GET  /api/admin/email_delivery_run — varredura manual do email monitor
//   GET  /api/admin/email_test       — envia email teste via Resend
const express = require('express');
const axios = require('axios');

const { isUuid: _isUuid } = require('../lib/validators');

const router = express.Router();

// Middleware de auth — usado em todas as rotas /api/admin/* (não no
// /api/admin_command pq esse é chamado pelo n8n que tem sua própria
// trava).
function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_API_SECRET || process.env.ABACATEPAY_WEBHOOK_SECRET;
  if (!expected || req.query.secret !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// POST /api/admin_command {cmd, phone} — processa comando do admin
// (TRAVADOS/VENDAS/PENDENTES/SUNO/RELATORIO) e responde no WhatsApp.
// `sync=true` (opcional) AGUARDA o resultado e devolve erros inline pra debug.
router.post('/api/admin_command', async (req, res) => {
  try {
    const { cmd, phone, sync } = req.body || {};
    const { handleAdminCommand } = require('../lib/adminCommands');
    if (sync) {
      try {
        await handleAdminCommand(cmd, phone);
        return res.json({ ok: true, cmd, mode: 'sync' });
      } catch (e) {
        return res.json({ ok: false, cmd, mode: 'sync', error: e.message, stack: e.stack });
      }
    }
    handleAdminCommand(cmd, phone).catch((e) => console.error('[admin_command] async erro:', e.message));
    res.json({ ok: true, cmd });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══ Trigger manual do Suno monitor — varre orders sem URL de áudio ═══
// GET /api/admin/suno_monitor_run?secret=XXX → executa varredura agora
router.get('/api/admin/suno_monitor_run', adminAuth, async (req, res) => {
  try {
    const { runOnce } = require('../lib/sunoMonitor');
    const r = await runOnce();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Trigger manual do fallback pra UMA order específica ═══
// GET /api/admin/suno_rescue?id=ORDER_ID&secret=XXX
router.get('/api/admin/suno_rescue', adminAuth, async (req, res) => {
  if (!_isUuid(req.query.id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const { ensureAudioUrls } = require('../lib/sunoFallback');
    const r = await ensureAudioUrls(req.query.id, { maxRetries: 5 });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Trigger manual do CAPI monitor — útil pra debug e dashboard admin ═══
// GET /api/admin/capi_monitor_run?secret=XXX → executa a varredura agora
router.get('/api/admin/capi_monitor_run', adminAuth, async (req, res) => {
  try {
    const { runOnce } = require('../lib/capiMonitor');
    const r = await runOnce();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Trigger manual do Email Delivery monitor ═══
router.get('/api/admin/email_delivery_run', adminAuth, async (req, res) => {
  try {
    const { runOnce } = require('../lib/emailDeliveryMonitor');
    const r = await runOnce();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Envia email de teste pra validar template + DNS (não toca no DB) ═══
// GET /api/admin/email_test?secret=XXX&to=alguem@email.com&orderId=optional
router.get('/api/admin/email_test', adminAuth, async (req, res) => {
  try {
    const to = String(req.query.to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'param to= obrigatório (email válido)' });
    // Dataset fake só pra renderizar — não persiste no DB
    const fakeOrder = {
      id: req.query.orderId || '00000000-0000-0000-0000-000000000000',
      honoree_name: 'Maria',
      customer_name: 'Cliente Teste',
      customer_email: to,
      plan: req.query.plan || 'completa',
      original_audio_url: 'https://tempfile.aiquickdraw.com/r/teste.mp3', // só pra passar no check de hasMedia
      email_delivery_sent: false,
    };
    const { renderHtml } = require('../lib/emailDelivery');
    // Envio direto via Resend pra não marcar a flag de orders
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'RESEND_API_KEY não configurada' });
    const r = await axios.post('https://api.resend.com/emails', {
      from: `${process.env.EMAIL_FROM_NAME || 'Bia da Lembrança Cantada'} <${process.env.EMAIL_FROM || 'bia@lembrancacantada.com'}>`,
      to: [to],
      reply_to: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'bia@lembrancacantada.com',
      subject: '🎵 [TESTE] Sua música para Maria está pronta!',
      html: renderHtml({
        honoree: fakeOrder.honoree_name,
        customerName: fakeOrder.customer_name,
        plan: fakeOrder.plan,
        deliveryUrl: `${process.env.APP_URL || 'https://app.lembrancacantada.com'}/p/${fakeOrder.id}`,
      }),
      tags: [{ name: 'kind', value: 'test' }],
    }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    res.json({ ok: true, id: r.data?.id });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

module.exports = router;
