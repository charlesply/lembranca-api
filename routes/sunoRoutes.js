// sunoRoutes — proxies pra Suno + file serves de audio + transcricao.
//
// Rotas (8):
//   GET  /api/preview/:filename  — serve MP3 previa do disco (com self-heal)
//   GET  /api/original/:filename — serve MP3 original do disco
//   GET  /api/download           — proxy de download forcado (whitelist hosts)
//   GET  /api/get_limit          — creditos restantes no Suno
//   POST /api/custom_generate    — geracao Suno custom (prompt+tags+title+...)
//   POST /api/generate           — geracao Suno simples
//   GET  /api/get?ids=x,y        — info de clips Suno
//   POST /api/transcribe         — Whisper/AssemblyAI (audio multipart)
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const FormData = require('form-data');

const { supaFetch } = require('../lib/supabase');
const { getClient, resetClient, isAuthError } = require('../lib/suno');
const { createPreviewFromUrl, PREVIEW_DIR, ORIGINALS_DIR } = require('../lib/audio');

const router = express.Router();

// Multer config local — aceita audio ate 25MB (limite do Whisper).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Servir previews (com self-heal: regenera do CDN se o disco efemero apagou)
router.get('/api/preview/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(PREVIEW_DIR, filename);
  // AUTO-CURA: o disco e efemero (redeploy apaga). Se o arquivo sumiu, regenera da fonte (Suno CDN).
  if (!fs.existsSync(filePath)) {
    const _dbg = { _v: 'dbg1', rows: 0, foundOrder: false, src: null, err: null };
    try {
      // Busca o pedido DONO desta prévia pela URL — SEM janela de 120.
      // (Antes só olhava os 120 mais recentes → prévias antigas davam 404.)
      // %->%25: o filename codificado tem % (acento → %C3%AD). Sem escapar, o transporte
      // HTTP decodifica de volta pro acento antes do PostgREST → o LIKE procura "Lavínia"
      // literal, mas a preview_audio_url salva guarda "%C3%AD" literal → 0 rows. Escapando
      // o % (→ %25) o PostgREST recebe o % literal (vira wildcard) e ACHA o pedido.
      const _enc = encodeURIComponent(filename).replace(/%/g, '%25');
      const rows = await supaFetch('GET', `orders?preview_audio_url=like.*${_enc}&select=id,original_audio_url,full_audio_urls,preview_audio_url&limit=5`);
      _dbg.rows = Array.isArray(rows) ? rows.length : -1;
      // FIX: a preview_audio_url salva é URL-ENCODED (acento → %C3%AD), mas req.params.filename
      // vem DECODIFICADO pelo Express → endsWith(filename) NUNCA casava em nome com acento
      // (Lavínia, Lúcia, Cecília...) → o=undefined → não regenerava → 404. Compara nas 2 formas.
      const o = (Array.isArray(rows) ? rows : []).find(r => {
        const u = String(r.preview_audio_url || '');
        return u.endsWith(filename) || u.endsWith(encodeURIComponent(filename)) || decodeURIComponent(u).endsWith(filename);
      });
      _dbg.foundOrder = !!o;
      // Fonte do áudio: original_audio_url; fallback pro 1º full_audio_urls.
      let src = o && o.original_audio_url;
      if (o && !src && o.full_audio_urls) {
        try {
          const arr = typeof o.full_audio_urls === 'string'
            ? JSON.parse(o.full_audio_urls.replace(/'/g, '"'))
            : o.full_audio_urls;
          if (Array.isArray(arr) && arr[0]) src = arr[0];
        } catch (_) {}
      }
      _dbg.src = src ? String(src).slice(0, 45) : null;
      if (o && src) {
        const title = decodeURIComponent(filename).replace(/_preview\.mp3$/i, '').replace(/_/g, ' ');
        console.log(`[Preview self-heal] regenerando ${filename} (order ${o.id})`);
        await createPreviewFromUrl(src, o.id, title);
      }
    } catch (e) { _dbg.err = e.message; console.error('[Preview self-heal] falhou:', e.message); }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preview nao encontrado.', _dbg });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `inline; filename="${decodeURIComponent(filename)}"`);
  fs.createReadStream(filePath).pipe(res);
});

// Servir originais
router.get('/api/original/:filename', (req, res) => {
  const filePath = path.join(ORIGINALS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Original nao encontrado.' });
  res.setHeader('Content-Type', 'audio/mpeg');
  const friendlyName = decodeURIComponent(req.params.filename);
  res.setHeader('Content-Disposition', `attachment; filename="${friendlyName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// PROXY DE DOWNLOAD — forca o download (Content-Disposition: attachment) de arquivos remotos.
// Resolve o problema do iOS/mobile que ignora o atributo download em links cross-origin (toca em vez de baixar).
router.get('/api/download', async (req, res) => {
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

// GET /api/get_limit — creditos restantes no Suno
router.get('/api/get_limit', async (req, res) => {
  try {
    const c = await getClient();
    res.json(await c.getLimit());
  } catch (err) {
    console.error('[/api/get_limit]', err.message);
    if (isAuthError(err.message)) resetClient();
    res.status(500).json({ error: err.message });
  }
});

// POST /api/custom_generate — geracao Suno custom
router.post('/api/custom_generate', async (req, res) => {
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

// POST /api/generate — geracao Suno simples
router.post('/api/generate', async (req, res) => {
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

// GET /api/get?ids=xxx,yyy — info de clips
router.get('/api/get', async (req, res) => {
  try {
    const c = await getClient();
    res.json(await c.getClips(req.query.ids || ''));
  } catch (err) {
    console.error('[/api/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transcribe — Whisper/AssemblyAI audio transcription (multipart 'audio')
router.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo de audio enviado.' });
  const buf = req.file.buffer;
  const mime = req.file.mimetype || 'audio/webm';
  console.log(`[Transcribe] ${(buf.length / 1024).toFixed(0)}KB ${mime}`);

  // 1) AssemblyAI (primario — igual ao n8n/site antigo, melhor p/ PT)
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
          console.log(`[Transcribe] ✅ AssemblyAI (${text.length} chars)`);
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
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
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
    console.log(`[Transcribe] ✅ Whisper (${text.length} chars)`);
    res.json({ text, provider: 'whisper' });
  } catch (err) {
    console.error('[/api/transcribe]', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha na transcricao: ' + (err.response?.data?.error?.message || err.message) });
  }
});

module.exports = router;
