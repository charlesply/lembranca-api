// ═══════════════════════════════════════════════════════════════════════════
// Sistema à prova de falhas pra garantir que TODA música paga tenha URL
// salva no DB.
//
// Por que existe (caso histórico — Rafael 06/06/2026):
//   1. Cliente paga.
//   2. Suno gera a música com sucesso, faz upload pro cdn1.suno.ai.
//   3. Webhook /api/webhooks/sunoapi recebe `complete` com 2 tracks.
//   4. Mas o handler atual SÓ salva snapshot em error_message — NÃO extrai
//      audioUrl nem clipIds pro DB. Resultado: cliente fica sem música.
//   5. Depois de horas, Suno API record-info passa a retornar FAILED
//      mesmo com áudio salvo no CDN (bug do provider).
//
// Esta lib resolve via DOIS caminhos redundantes:
//   A) getTaskStatus() — pergunta record-info pro Suno API
//   B) cdn1.suno.ai/{clipId}.mp3 — URL determinística (sempre existe se a
//      música foi gerada, mesmo se o record-info mente)
//
// Com retry 5x e backoff exponencial entre tentativas. Idempotente — pode
// ser chamada várias vezes sem efeito colateral.
// ═══════════════════════════════════════════════════════════════════════════
const axios = require('axios');
const { getTaskStatus } = require('./sunoApi');
const { supaFetch } = require('./supabase');

const CDN_BASE = 'https://cdn1.suno.ai';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// HEAD pra confirmar que a URL existe sem baixar o áudio inteiro.
async function urlExists(url) {
  try {
    const r = await axios.head(url, { timeout: 8000, maxRedirects: 3 });
    return r.status >= 200 && r.status < 300;
  } catch (_) {
    return false;
  }
}

// Constrói URLs cdn1.suno.ai a partir dos clip IDs salvos e valida cada uma
// via HEAD. Retorna só as que existem.
async function urlsFromClipIds(clipIds) {
  if (!Array.isArray(clipIds) || !clipIds.length) return [];
  const out = [];
  for (const id of clipIds) {
    const url = `${CDN_BASE}/${id}.mp3`;
    if (await urlExists(url)) out.push(url);
  }
  return out;
}

// Extrai URLs e clipIds de uma resposta do record-info da Suno API.
function tracksToUrls(tracks) {
  if (!Array.isArray(tracks)) return { urls: [], ids: [] };
  const urls = [], ids = [];
  for (const t of tracks) {
    const id = t.id || t.clipId;
    const u = t.audioUrl || t.audio_url || t.sourceAudioUrl
              || (id ? `${CDN_BASE}/${id}.mp3` : null);
    if (id) ids.push(id);
    if (u) urls.push(u);
  }
  return { urls, ids };
}

// Tenta resolver as URLs por todas as estratégias disponíveis.
// Retorna { urls, ids, source } ou null se nada funcionar.
async function resolveUrlsForOrder(order) {
  const taskId = order.suno_task_id;
  const savedClipIds = order.suno_clip_ids;

  // Estratégia A: chama getTaskStatus do Suno API
  if (taskId) {
    try {
      const r = await getTaskStatus(taskId);
      const tracks = r?.tracks || r?.response?.sunoData
                  || r?.data?.response?.sunoData || [];
      const { urls, ids } = tracksToUrls(tracks);
      if (urls.length) return { urls, ids, source: 'sunoapi/record-info' };
    } catch (e) {
      console.warn('[sunoFallback] getTaskStatus falhou:', e.message);
    }
  }

  // Estratégia B: usa clip IDs já salvos no DB (do webhook anterior) e tenta
  // cdn1.suno.ai/{id}.mp3 — funciona mesmo quando record-info mente
  if (Array.isArray(savedClipIds) && savedClipIds.length) {
    const urls = await urlsFromClipIds(savedClipIds);
    if (urls.length) return { urls, ids: savedClipIds, source: 'cdn1.suno.ai/clipIds' };
  }

  return null;
}

// Garante que a order tenha original_audio_url + full_audio_urls preenchidos.
// Faz até `maxRetries` tentativas, com backoff exponencial entre elas.
//
// Retorna { ok: true, urls } se conseguiu, ou { ok: false, reason } se não.
// SEGURO chamar várias vezes — se já tem URLs no DB, retorna no-op.
async function ensureAudioUrls(orderId, opts = {}) {
  const maxRetries = opts.maxRetries || 5;
  const baseDelayMs = opts.baseDelayMs || 5000; // 5s, 10s, 20s, 40s, 80s

  const rows = await supaFetch('GET',
    `orders?id=eq.${orderId}&select=id,suno_task_id,suno_clip_ids,original_audio_url,full_audio_urls`);
  const o = Array.isArray(rows) && rows[0];
  if (!o) return { ok: false, reason: 'order_not_found' };

  // Já tem URLs — nada a fazer
  if (o.original_audio_url && Array.isArray(o.full_audio_urls) && o.full_audio_urls.length) {
    return { ok: true, urls: o.full_audio_urls, source: 'already_saved' };
  }
  if (!o.suno_task_id && !(Array.isArray(o.suno_clip_ids) && o.suno_clip_ids.length)) {
    return { ok: false, reason: 'no_task_id_or_clip_ids' };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resolved = await resolveUrlsForOrder(o);
    if (resolved && resolved.urls.length) {
      const patch = {
        full_audio_urls: resolved.urls,
        original_audio_url: resolved.urls[0],
      };
      if (resolved.ids?.length) patch.suno_clip_ids = resolved.ids;
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, patch);
      console.log(`[sunoFallback] ✅ ${orderId.slice(0,8)} resgatado via ${resolved.source} (${resolved.urls.length} URLs, tentativa ${attempt}/${maxRetries})`);
      return { ok: true, urls: resolved.urls, source: resolved.source, attempts: attempt };
    }
    if (attempt < maxRetries) {
      const wait = baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`[sunoFallback] ${orderId.slice(0,8)} tentativa ${attempt} falhou — esperando ${wait}ms`);
      await sleep(wait);
    }
  }

  console.error(`[sunoFallback] ❌ ${orderId.slice(0,8)} esgotou ${maxRetries} tentativas`);
  return { ok: false, reason: 'all_retries_exhausted' };
}

module.exports = { ensureAudioUrls, resolveUrlsForOrder, urlsFromClipIds, tracksToUrls };
