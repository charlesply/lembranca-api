const cookie = require('cookie');
let _playwright = null;
let _browser = null;
let _context = null;
let _page = null;
let _initPromise = null;
let _lastHealthCheck = 0;
let _healthy = false;

const SUNO_BASE = 'https://studio-api-prod.suno.com';  // FIX: hifens, igual SunoClient.js usa
const SUNO_HOME = 'https://suno.com/create';

function _generateBrowserToken() {
  const ts = Date.now();
  const btPayload = JSON.stringify({ timestamp: ts });
  const btB64 = Buffer.from(btPayload).toString('base64');
  return JSON.stringify({ token: btB64 });
}

function _getDeviceId(cookieStr) {
  // device-id = valor do ajs_anonymous_id cookie
  const m = (cookieStr || '').match(/ajs_anonymous_id=([^;\s]+)/);
  return m ? m[1] : 'c66a81b9-2de5-4720-b034-4496357581c6';
}

function _loadPlaywright() {
  if (_playwright) return _playwright;
  try { _playwright = require('playwright'); return _playwright; }
  catch (e) {
    const err = new Error('Playwright nao instalado');
    err.code = 'PLAYWRIGHT_NOT_INSTALLED';
    throw err;
  }
}

function _parseCookies(cookieStr) {
  const parsed = cookie.parse(cookieStr || '');
  return Object.entries(parsed)
    .map(([name, value]) => ({
      name, value: String(value), domain: '.suno.com', path: '/',
      httpOnly: false, secure: true, sameSite: 'Lax',
    }))
    // Filtrar nomes com chars inválidos pra Playwright (Playwright valida cookies strictly)
    .filter(c => /^[a-zA-Z0-9_\-]+$/.test(c.name) || c.name.startsWith('__'));
}

// Set cookies one-by-one, skipping invalid ones (tracking/analytics não importam pra auth)
async function _setCookiesSafe(context, cookies) {
  let ok = 0, skip = 0;
  for (const c of cookies) {
    try {
      await context.addCookies([c]);
      ok++;
    } catch (e) {
      skip++;
      // Silent - cookies de tracking podem falhar sem problema
    }
  }
  console.log('[Playwright] Cookies set:', ok, '| skip:', skip);
}

async function _ensureBrowser() {
  if (_browser && _context && _page && _healthy) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const { chromium } = _loadPlaywright();
    const cookieStr = process.env.SUNO_COOKIE || '';
    if (!cookieStr) throw new Error('SUNO_COOKIE env nao definido');

    // FALLBACK RUNTIME: se Chromium não existir, instala antes de continuar
    try {
      const fs = require('fs');
      const path = require('path');
      const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(require('os').homedir(), '.cache', 'ms-playwright');
      const hasChromium = fs.existsSync(cacheRoot) && fs.readdirSync(cacheRoot).some(d => d.startsWith('chrom'));
      if (!hasChromium) {
        console.log('[Playwright] Chromium não encontrado em', cacheRoot, '— instalando agora (~30s)...');
        const { execSync } = require('child_process');
        execSync('npx playwright install chromium chromium-headless-shell chrome-headless-shell 2>&1 || npx playwright install --with-deps 2>&1', { stdio: 'inherit', timeout: 180000 });
        console.log('[Playwright] Install runtime concluído');
      }
    } catch (e) { console.log('[Playwright] Verificação runtime falhou (continuando):', e.message); }

    _browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    });
    _context = await _browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
    });
    await _setCookiesSafe(_context, _parseCookies(cookieStr));
    _page = await _context.newPage();
    await _page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await _page.goto(SUNO_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await _page.waitForTimeout(3000);
    _healthy = true;
    _lastHealthCheck = Date.now();
  })();
  try { await _initPromise; } finally { _initPromise = null; }
}

async function _healthCheck() {
  if (!_page) return false;
  if (Date.now() - _lastHealthCheck < 60000 && _healthy) return true;
  try {
    const ua = await _page.evaluate(() => navigator.userAgent);
    _healthy = !!ua;
    _lastHealthCheck = Date.now();
    return _healthy;
  } catch { _healthy = false; return false; }
}

async function _getFreshJwt() {
  // ESTRATÉGIA PRINCIPAL: reusar o SunoClient HTTP (singleton), que mantém um JWT
  // fresco via keepAlive usando o __client (mesmo token que /api/get_limit usa com
  // sucesso). O minting do JWT NÃO precisa do fingerprint do browser — só o generate
  // precisa. O __session do cookie é efêmero (~60s) e quase sempre está expirado.
  try {
    const { getClient } = require('./lib/suno');
    const sc = await getClient();
    await sc.ensureToken(true);   // força renovar via Clerk (__client) se necessário
    if (sc.token) return sc.token;
  } catch (e) { console.log('[Playwright] JWT via SunoClient falhou:', e.message); }

  // FALLBACK: mint via Clerk dentro do browser (__client como Authorization header)
  const CLERK = 'https://auth.suno.com';
  const VERSION = '5.117.0';
  const clientToken = (process.env.SUNO_COOKIE || '').match(/__client=([^;\s]+)/)?.[1] || null;
  try {
    const result = await _page.evaluate(async ({ clerk, version, clientToken }) => {
      const authHeaders = clientToken ? { 'Authorization': clientToken } : {};
      const r1 = await fetch(`${clerk}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${version}`, { credentials: 'include', headers: authHeaders });
      const j1 = await r1.json().catch(() => null);
      const sid = j1?.response?.last_active_session_id || j1?.response?.sessions?.[0]?.id;
      if (!sid) return { sid: null, jwt: null };
      const r2 = await fetch(`${clerk}/v1/client/sessions/${sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${version}`, { method: 'POST', credentials: 'include', headers: authHeaders });
      const j2 = await r2.json().catch(() => null);
      return { sid, jwt: j2?.jwt || null };
    }, { clerk: CLERK, version: VERSION, clientToken });
    if (result.jwt) return result.jwt;
  } catch { /* continue */ }

  // ÚLTIMO RECURSO: __session do env só se AINDA for válido (nunca expirado)
  const m = (process.env.SUNO_COOKIE || '').match(/__session=([^;\s]+)/);
  if (m) {
    try {
      const p = JSON.parse(Buffer.from(m[1].split('.')[1] + '==', 'base64').toString());
      if (p.exp && p.exp * 1000 > Date.now() + 30000) return m[1];
    } catch {}
  }
  return null;
}

async function _shutdown() {
  try { if (_page) await _page.close(); } catch {}
  try { if (_context) await _context.close(); } catch {}
  try { if (_browser) await _browser.close(); } catch {}
  _page = null; _context = null; _browser = null; _healthy = false;
}

async function status() {
  const installed = (() => { try { require.resolve('playwright'); return true; } catch { return false; } })();
  return { installed, browser_running: !!_browser, page_ready: !!_page, healthy: _healthy };
}

async function _refreshAuth() {
  // Força recarregar a página pra Clerk regenerar JWT a partir do __client
  try {
    await _page.goto(SUNO_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await _page.waitForTimeout(4000);
    console.log('[Playwright] Page reload OK — JWT renovado');
    return true;
  } catch (e) {
    console.log('[Playwright] Page reload falhou:', e.message);
    return false;
  }
}

async function customGenerate(args) {
  await _ensureBrowser();
  if (!await _healthCheck()) { await _shutdown(); await _ensureBrowser(); }

  try {
    return await _doGenerate(args);
  } catch (err) {
    const is422 = err.response?.status === 422 || /Suno 422|token_validation/i.test(err.message || '');
    if (is422) {
      console.log('[Playwright] 422 detectado, forçando page.reload() + retry...');
      const refreshed = await _refreshAuth();
      if (refreshed) {
        return await _doGenerate(args);
      }
    }
    throw err;
  }
}

async function _doGenerate({ prompt, tags, title, model, make_instrumental, negative_tags, vocal_gender, wait_audio, weirdness, style_weight, lyrics_mode }) {
  const _norm = v => { if (v == null) return null; const n = Number(v); if (Number.isNaN(n)) return null; return n > 1 ? n / 100 : n; };
  const w  = _norm(weirdness) ?? 0.50;
  const sw = _norm(style_weight) ?? 0.50;
  // Sertanejo SEMPRE com Violão (regra do negócio): "Sertanejo, Feliz, ..." -> "Sertanejo, Violão, Feliz, ..."
  let _tags = tags;
  if (_tags && /sertanej/i.test(_tags) && !/viol[ãa]o/i.test(_tags)) _tags = _tags.replace(/(sertanej[^,]*)/i, '$1, Violão');
  const isMale = ['male','m','Masculino','masculino','Male'].includes(vocal_gender);
  const isFemale = ['female','f','Feminino','feminino','Female'].includes(vocal_gender);
  const vocalGenderShort = isMale ? 'm' : isFemale ? 'f' : null;

  // PAYLOAD CORRETO V5.5 — capturado da UI real
  // vocal_gender e weirdness vão DENTRO de metadata, NÃO no top-level
  const payload = {
    token: null,
    generation_type: 'TEXT',
    title: title || '',
    tags: _tags || '',
    negative_tags: negative_tags || '',
    mv: model || process.env.SUNO_MODEL || 'chirp-crow',
    prompt: prompt || '',
    make_instrumental: make_instrumental || false,
    user_uploaded_images_b64: null,
    metadata: {
      web_client_pathname: '/create',
      is_max_mode: false,
      is_mumble: false,
      create_mode: 'custom',
      disable_volume_normalization: false,
      control_sliders: {
        weirdness_constraint: w,
        ...(style_weight != null ? { style_weight: sw } : {}),
      },
      ...(vocalGenderShort ? { vocal_gender: vocalGenderShort } : {}),
    },
    override_fields: [],
    cover_clip_id: null, cover_start_s: null, cover_end_s: null,
    persona_id: null,
    artist_clip_id: null, artist_start_s: null, artist_end_s: null,
    continue_clip_id: null, continued_aligned_prompt: null, continue_at: null,
    transaction_uuid: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2),
    token_provider: null,
  };
  if (lyrics_mode === 'auto') {
    payload.generation_type = 'GENERATION';
    payload.gpt_description_prompt = prompt || '';
    payload.prompt = '';
  }
  const jwt = await _getFreshJwt();
  if (!jwt) throw new Error('Falha ao obter JWT');
  const deviceId = _getDeviceId(process.env.SUNO_COOKIE || '');
  const browserToken = _generateBrowserToken();
  const result = await _page.evaluate(async ({ url, body, bearer, deviceId, browserToken }) => {
    const r = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + bearer,
        'browser-token': browserToken,
        'device-id': deviceId,
        'Origin': 'https://suno.com',
        'Referer': 'https://suno.com/',
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, ok: r.ok, data, raw: data ? null : text.slice(0, 1000) };
  }, { url: `${SUNO_BASE}/api/generate/v2-web/`, body: payload, bearer: jwt, deviceId, browserToken });
  if (!result.ok) {
    const err = new Error(`Suno ${result.status}: ${JSON.stringify(result.data || result.raw).slice(0, 300)}`);
    err.response = { status: result.status, data: result.data };
    throw err;
  }
  const clips = (result.data && result.data.clips) || [];
  if (wait_audio && clips.length > 0) return await _waitForClips(clips.map(c => c.id));
  return clips.map(_normalizeClip);
}

function _normalizeClip(c) {
  return {
    id: c.id, title: c.title, status: c.status,
    audio_url: c.audio_url || '', video_url: c.video_url || '',
    image_url: c.image_large_url || c.image_url || '',
    lyric: c.metadata?.prompt || '', model_name: c.model_name || '',
    created_at: c.created_at, tags: c.metadata?.tags || '',
    duration: c.metadata?.duration_formatted || '',
  };
}

async function _waitForClips(clipIds, maxWaitMs = 240000, pollMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const jwt = await _getFreshJwt();
    const deviceId = _getDeviceId(process.env.SUNO_COOKIE || '');
    const browserToken = _generateBrowserToken();
    const result = await _page.evaluate(async ({ url, bearer, deviceId, browserToken }) => {
      const r = await fetch(url, {
        method: 'GET', credentials: 'include',
        headers: {
          'Authorization': 'Bearer ' + bearer,
          'browser-token': browserToken,
          'device-id': deviceId,
          'Origin': 'https://suno.com',
          'Referer': 'https://suno.com/',
        }
      });
      const text = await r.text();
      try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
      catch { return { ok: r.ok, status: r.status, data: null }; }
    }, { url: `${SUNO_BASE}/api/feed/v2/?ids=${clipIds.join(',')}`, bearer: jwt, deviceId, browserToken });
    if (result.ok && Array.isArray(result.data?.clips)) {
      const clips = result.data.clips;
      if (clips.every(c => c.status === 'complete' || c.status === 'error')) {
        return clips.map(_normalizeClip);
      }
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Timeout aguardando clips`);
}

// ═══ KEEP-WARM (Fase 1 - isolado): renova a sessao via interacao de browser real ═══
// Sobe o browser logado, navega/interage no suno.com pra forcar o Clerk a renovar,
// e devolve os cookies ATUALIZADOS (pra quem consumir manter a sessao quente).
async function keepWarm() {
  const t0 = Date.now();
  await _ensureBrowser();
  if (!await _healthCheck()) { await _shutdown(); await _ensureBrowser(); }

  // Interacao "humana": recarrega a pagina + scroll + espera (Clerk renova __session no bg)
  try {
    await _page.goto(SUNO_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await _page.waitForTimeout(4000);
    await _page.evaluate(() => { try { window.scrollBy(0, 600); } catch (e) {} }).catch(() => {});
    await _page.waitForTimeout(2000);
    // Forca o Clerk a tocar o /v1/client (renova __client/__session) via a propria JS da pagina
    await _page.evaluate(async () => {
      try { await fetch('https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0', { credentials: 'include' }); } catch (e) {}
    }).catch(() => {});
    await _page.waitForTimeout(2000);
  } catch (e) { console.log('[KeepWarm] interacao falhou (continua):', e.message); }

  // Le os cookies renovados do contexto
  const cookies = await _context.cookies('https://suno.com');
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const names = cookies.map(c => c.name);

  // diagnostico: exp do __session (deve estar fresco se renovou)
  let sessionExpIn = null;
  const sc = cookies.find(c => c.name === '__session');
  if (sc) { try { const p = JSON.parse(Buffer.from(sc.value.split('.')[1] + '==', 'base64').toString()); if (p.exp) sessionExpIn = p.exp - Math.floor(Date.now() / 1000); } catch (e) {} }
  let clientExpDays = null;
  const cc = cookies.find(c => c.name === '__client');
  if (cc) { try { const p = JSON.parse(Buffer.from(cc.value.split('.')[1] + '==', 'base64').toString()); if (p.exp) clientExpDays = Math.floor((p.exp - Date.now() / 1000) / 86400); } catch (e) {} }

  // logado? (presenca das chaves criticas do Clerk)
  const loggedIn = names.includes('__client') && names.includes('__client_uat') && names.includes('__session');

  return {
    elapsed_ms: Date.now() - t0,
    cookie: cookieStr,
    cookie_length: cookieStr.length,
    keys: names,
    n_keys: names.length,
    logged_in: loggedIn,
    session_exp_in_s: sessionExpIn,   // segundos ate o __session expirar (fresco se ~3000+)
    client_exp_days: clientExpDays,
  };
}

module.exports = { status, customGenerate, shutdown: _shutdown, _ensureBrowser, keepWarm };
