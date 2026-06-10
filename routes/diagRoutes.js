// diagRoutes — rotas de diagnóstico e debug (sem impacto em negócio).
// Usadas pra inspecionar o estado do servidor, testar Playwright, validar
// cookies do Suno, etc. Nenhuma toca o DB de orders.
//
// Rotas:
//   GET  /api/diag                — estado geral do serviço
//   GET  /api/test-client         — testa init do client do Suno
//   GET  /api/test-preview        — testa pipeline Audio-Edit com URL
//   GET  /api/active_cookie       — qual cookie o getClient() usaria
//   GET  /api/cookie_health       — health check do cookie + créditos
// (rotas Playwright removidas em 10/jun/2026)
const express = require('express');
const { getClient, resetClient, isAuthError } = require('../lib/suno');
const { createPreviewFromUrl } = require('../lib/audio');

const router = express.Router();

// Diagnostic geral
router.get('/api/diag', async (req, res) => {
  const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
  const parsed = require('cookie').parse(SUNO_COOKIE);
  let clientReady = false;
  try { clientReady = !!(await getClient()); } catch (_) {}
  res.json({
    cookie_length: SUNO_COOKIE.length,
    has_client_key: SUNO_COOKIE.includes('__client'),
    parsed_keys: Object.keys(parsed),
    client_initiated: clientReady,
    gpt_enabled: !!process.env.OPENAI_API_KEY,
    supabase_configured: !!(process.env.SUPABASE_KEY),
    inngest_enabled: true,
    inngest_concurrency: 2,
  });
});

// Debug: testar client init síncrono
router.get('/api/test-client', async (req, res) => {
  try {
    const c = await getClient();
    res.json({ ok: true, client_ready: !!c });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Debug: testar pipeline Audio-Edit com URL de áudio
// GET /api/test-preview?url=https://cdn1.suno.ai/...
router.get('/api/test-preview', async (req, res) => {
  const SELF_URL = process.env.SELF_URL || 'https://api-suno.linkarbox.app';
  const AUDIO_EDIT_URL_LOCAL = process.env.AUDIO_EDIT_URL || 'http://audio-edit:5000';
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Passe ?url=https://cdn1.suno.ai/xxx.mp3' });
  try {
    console.log(`[test-preview] Testando Audio-Edit com: ${url.substring(0, 70)}...`);
    const preview = await createPreviewFromUrl(url, 'test-' + Date.now());
    const previewUrl = `${SELF_URL}/api/preview/${preview.previewFilename}`;
    console.log(`[test-preview] ✅ OK: ${previewUrl}`);
    res.json({ ok: true, preview_url: previewUrl, filename: preview.previewFilename });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[test-preview] ❌ ERRO:`, detail);
    res.status(500).json({ ok: false, error: detail, audio_edit_url: AUDIO_EDIT_URL_LOCAL });
  }
});

// ═══ PLAYWRIGHT REMOVIDO em 10/jun/2026 ═══
// Antes existiam rotas /api/playwright_status, /api/test_playwright,
// /api/playwright_shutdown e /api/keepwarm_test. Foram removidas junto com
// PlaywrightDriver.js + lib/keepWarm.js — SUNOAPI eh path primario, cookie path
// HTTP (SunoClient.js) continua funcional como fallback, mas browser nao.

// GET /api/active_cookie — inspeciona qual cookie o getClient() usaria AGORA
// (warm da tabela vs env), sem alterar nada.
router.get('/api/active_cookie', async (req, res) => {
  try {
    const { getActiveCookie } = require('../lib/suno');
    const r = await getActiveCookie();
    res.json({
      source: r.source,
      cookie_length: (r.cookie || '').length,
      age_min: r.age_min,
      warm_age_min: r.warm_age_min,
      use_warm_flag: String(process.env.USE_WARM_COOKIE).toLowerCase() === 'true',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cookie_health — health check completo do cookie + créditos.
// Usado por um Schedule do n8n pra avisar ANTES do cookie quebrar.
router.get('/api/cookie_health', async (req, res) => {
  const parsed = require('cookie').parse(process.env.SUNO_COOKIE || '');
  // Chaves que o Clerk precisa pra estabelecer a sessao no browser.
  // (a falta delas foi a causa do 422 token_validation_failed)
  const essential = ['__client', '__client_uat', 'clerk_active_context', '__session'];
  const missing = essential.filter(k => !parsed[k]);

  // dias restantes ate o __client (refresh token) expirar
  let clientDays = null;
  try {
    const p = JSON.parse(Buffer.from((parsed['__client'] || '').split('.')[1] + '==', 'base64').toString());
    if (p.exp) clientDays = Math.floor((p.exp * 1000 - Date.now()) / 86400000);
  } catch (_) {}

  // sessao viva? (get_limit usa o token via Clerk)
  let credits = null, getLimitOk = false;
  try {
    const c = await getClient();
    const lim = await c.getLimit();
    credits = lim.credits_left;
    getLimitOk = true;
  } catch (e) {
    if (isAuthError(e.message)) resetClient();
  }

  const reasons = [];
  if (missing.length) reasons.push('Cookie SEM chaves essenciais: ' + missing.join(', '));
  if (clientDays != null && clientDays < 30) reasons.push('__client expira em ' + clientDays + ' dias');
  if (!getLimitOk) reasons.push('get_limit falhou (sessão pode estar morta)');
  if (credits != null && credits < 10) reasons.push('Créditos baixos: ' + credits);

  const alert = reasons.length > 0;
  res.json({
    ok: true,
    healthy: !alert,
    alert,
    reason: reasons.join(' | ') || 'tudo certo',
    cookie_length: (process.env.SUNO_COOKIE || '').length,
    missing_essential: missing,
    client_expires_days: clientDays,
    credits_left: credits,
    get_limit_ok: getLimitOk,
  });
});

module.exports = router;
