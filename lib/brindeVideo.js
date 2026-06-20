// Geração do VÍDEO DE BRINDE (vídeo com a letra) pro fluxo do SITE.
// Idempotente, resiliente a jobs longos: persiste video_brinde_job_id no DB
// e RETOMA poll entre crons em vez de criar novo job a cada tick.
//
// FIX 12/jun/2026: antes _gerar() pollava 5min então desistia; cron disparava
// NOVO job a cada 4min → loop cumulativo de jobs duplicados pro mesmo audio
// (caso Daniel/Rosiany: 6h sem video, fila inflada).
// Agora: persiste job_id, retoma poll, STALE timeout 30min antes de recriar.
const axios = require('axios');
const { supaFetch } = require('./supabase');

// Defaults = infra do CHARLES (video-api.bvph.uk). NUNCA a do amigo
// (video-suno-api.linkarbox.app / key hc_). Key default vazia — vem da env.
const VIDEO_API = process.env.VIDEO_API_URL || process.env.LYRIC_VIDEO_API_URL || 'https://video-api.bvph.uk';
const VIDEO_KEY = process.env.VIDEO_API_KEY || process.env.LYRIC_VIDEO_API_KEY || '';
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Pexels: capa por CATEGORIA (relação + idade + gênero) ────────────────────
// Resolve a reclamação de "casal se beijando" em música infantil: NUNCA usa
// imagem romântica pra criança. Decidimos AQUI (temos os dados do pedido) e
// passamos a imagem pronta pro video-api via image_url, sobrescrevendo o default
// romântico dele. Key é do CHARLES (env PEXELS_API_KEY) — nunca a do amigo.
// Regras aprovadas:
//   • filho/afilhado + (gênero Infantil OU idade<=12 OU bebê) → imagens infantis
//   • filho/neto/afilhado/sobrinho (>12 ou idade desconhecida) → balões de festa
//   • romântico (esposo/namorado/...) → amor/casal (aí PODE)
//   • mãe/pai/avó/amigo/gospel → contexto da relação
//   • resto → fundo neutro (NUNCA casal)
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';

function _extractAge(story) {
  const s = String(story || '').toLowerCase();
  const m = s.match(/(\d{1,2})\s*(aninhos?|anos?|ano)\b/);
  if (m) return parseInt(m[1], 10);
  if (/\b\d{1,2}\s*mes(es)?\b/.test(s) || /beb[eê]|rec[eé]m.?nascid/.test(s)) return 0; // bebê
  return null;
}

function _categoryQueries(o) {
  const rel = (o.relationship || '').toLowerCase();
  const genre = (o.genre || '').toLowerCase();
  const age = _extractAge(o.story);
  const isInfantil = /infantil/.test(genre);
  const isFilhoAfilhado = /(filh|afilhad)/.test(rel);
  const isChildRecipient = /(filh|afilhad|net|sobrinh)/.test(rel);
  // CRIANÇA → imagens infantis (objetos/brincadeiras, sem rosto)
  if (isInfantil || (isFilhoAfilhado && age !== null && age <= 12)) {
    return ['colorful toys childhood playful', 'rainbow balloons confetti party', 'colorful crayons kids'];
  }
  // FILHO/NETO/AFILHADO/SOBRINHO (>12 ou idade desconhecida) → balões de festa
  if (isChildRecipient) {
    return ['colorful party balloons celebration', 'birthday balloons confetti festive', 'golden balloons celebration'];
  }
  // ROMÂNTICO → aí PODE amor/casal
  if (/(espos|marid|mulher|namor|paquera|amor|crush|companheir|parceir)/.test(rel)) {
    return ['romantic love sunset couple silhouette', 'love hearts warm bokeh', 'romantic flowers candlelight'];
  }
  if (/(m[ãa]e|mam[ãa]e|madrinha)/.test(rel)) return ['flowers warm mother love', 'soft flowers bouquet warm'];
  if (/(pai|papai|padrinho)/.test(rel)) return ['warm sunset hands family', 'mountain sunrise warm'];
  if (/(av[óo]|v[óo]v[óo]|v[óo])/.test(rel)) return ['nostalgic warm flowers light', 'vintage warm flowers'];
  if (/amig/.test(rel)) return ['friendship celebration confetti', 'warm bokeh lights party'];
  if (/(gospel|religios|igreja|deus|f[ée])/.test(genre)) return ['sky light peaceful clouds', 'sunrise nature peaceful'];
  // DEFAULT seguro — nunca casal
  return ['warm bokeh lights abstract', 'soft golden light nature'];
}

async function _pexelsImage(queries) {
  if (!PEXELS_API_KEY) return null;
  for (const q of queries) {
    try {
      const r = await axios.get('https://api.pexels.com/v1/search', {
        headers: { Authorization: PEXELS_API_KEY },
        params: { query: q, per_page: 15, orientation: 'portrait', size: 'large' },
        timeout: 12000,
      });
      const photos = (r.data && r.data.photos) || [];
      if (photos.length) {
        const pick = photos[Math.floor(Math.random() * Math.min(photos.length, 10))]; // varia a capa
        const url = pick.src && (pick.src.large || pick.src.large2x || pick.src.portrait);
        if (url) { console.log(`[BrindeVideo] 🖼️ Pexels "${q}" (${photos.length} fotos)`); return url; }
      }
    } catch (e) { console.error('[BrindeVideo] pexels erro:', e.response?.status || e.message); }
  }
  return null;
}
const _running = new Set();
let _timer = null;

// Poll: 60 * 20s = 20 min por invocacao. Se nao terminar, proximo cron retoma.
const POLL_ITERATIONS = 60;
const POLL_INTERVAL_MS = 20000;
// Stale: 30 min sem completar = abandona job e recria no proximo tick.
const STALE_JOB_MS = 30 * 60 * 1000;

// Soberania de dados: a video-api retorna URL no Supabase do AMIGO. A gente
// baixa o MP4 e re-upa no NOSSO Supabase (bucket 'videos') antes de gravar a
// URL no pedido. Assim NADA gerado pelo nosso backend fica armazenado no
// Supabase de terceiros.
async function _rehostVideoToMySupabase(externalUrl) {
  const SUPA_URL = process.env.SUPABASE_URL || '';
  const SUPA_KEY = process.env.SUPABASE_KEY || '';
  if (!SUPA_URL || !SUPA_KEY) {
    console.warn('[BrindeVideo] SUPABASE_URL/KEY ausente — não consigo re-uplodar, salvando URL externa');
    return externalUrl;
  }
  // Se a URL ja' esta no NOSSO Supabase (ex: video-api re-uplodou direto),
  // nao re-hospeda — economiza banda e elimina ponto de falha.
  if (externalUrl.includes(SUPA_URL.replace(/https?:\/\//, '').replace('/rest/v1', ''))) {
    return externalUrl;
  }
  try {
    const STORAGE_BASE = SUPA_URL.replace('/rest/v1', '') + '/storage/v1';
    const BUCKET = 'videos';
    const filename = externalUrl.split('/').pop().split('?')[0];
    if (!filename || !filename.endsWith('.mp4')) {
      console.warn('[BrindeVideo] filename inesperado, mantendo URL externa:', filename);
      return externalUrl;
    }
    const dlHeaders = {};
    if (externalUrl.includes('video-suno-api') || externalUrl.includes(VIDEO_API.replace(/https?:\/\//, ''))) {
      dlHeaders['X-API-Key'] = VIDEO_KEY;
    }
    const dl = await axios.get(externalUrl, {
      responseType: 'arraybuffer',
      headers: dlHeaders,
      timeout: 120000,
    });
    const buf = Buffer.from(dl.data);
    if (buf.length < 1024) {
      throw new Error('arquivo muito pequeno (' + buf.length + ' bytes) — provável erro do upstream');
    }
    await axios.post(
      `${STORAGE_BASE}/object/${BUCKET}/${filename}`,
      buf,
      {
        headers: {
          Authorization: `Bearer ${SUPA_KEY}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000,
      }
    );
    const newUrl = `${STORAGE_BASE}/object/public/${BUCKET}/${filename}`;
    console.log(`[BrindeVideo] 📦 re-uplodado p/ nosso Supabase (${Math.round(buf.length/1024)}KB) → ${filename}`);
    return newUrl;
  } catch (e) {
    const msg = e.response?.status ? `${e.response.status} ${e.response.statusText}` : e.message;
    console.error('[BrindeVideo] ⚠ falha no rehost, mantendo URL externa:', msg);
    return externalUrl;
  }
}

// Submete NOVO job ao video-api. Retorna job_id ou null.
async function _submitJob(audioUrl, title, imageUrl, lyrics) {
  const params = { audio_url: audioUrl, title: title };
  if (imageUrl) params.image_url = imageUrl;
  // Letra OFICIAL (final_lyrics) como FONTE DE VERDADE das palavras: o video-api
  // faz forced alignment via AssemblyAI (só o TEMPO de cada palavra) contra esse
  // texto — karaokê preciso, sem erro de transcrição. Ver app.py
  // transcribe_lyrics(lyrics_override=...) no repo do video-api.
  if (lyrics && String(lyrics).trim().length > 10) params.lyrics = String(lyrics).trim();
  const body = new URLSearchParams(params).toString();
  try {
    const g = await axios.post(`${VIDEO_API}/api/generate`, body, {
      headers: { 'X-API-Key': VIDEO_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    return (g.data && g.data.job_id) || null;
  } catch (e) {
    console.error('[BrindeVideo] _submitJob erro:', e.response?.status || '', e.message);
    return null;
  }
}

// Polla UM job_id ja criado. Retorna {done, url, failed}.
// done=true & url=string → pronto
// done=true & failed=true → falhou no video-api
// done=false → ainda em progresso (timeout do poll, proximo tick retoma)
async function _pollJob(jobId) {
  for (let i = 0; i < POLL_ITERATIONS; i++) {
    try {
      const j = await axios.get(`${VIDEO_API}/api/jobs/${jobId}`, {
        headers: { 'X-API-Key': VIDEO_KEY }, timeout: 15000,
      });
      const st = j.data && j.data.status;
      if (st === 'done') return { done: true, url: j.data.public_url || j.data.video_url };
      if (st === 'error' || st === 'failed') return { done: true, url: null, failed: true };
    } catch (_) { /* keep polling */ }
    await _sleep(POLL_INTERVAL_MS);
  }
  return { done: false, url: null };
}

// Finaliza: rehost + salva no DB + limpa job_id.
async function _finalizeVideo(orderId, externalUrl, extraPatch) {
  const videoUrl = await _rehostVideoToMySupabase(externalUrl);
  await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
    video_brinde_url: videoUrl,
    video_brinde_job_id: null,
    video_brinde_started_at: null,
    ...(extraPatch || {}),
  });
}

// Limpa marcadores de job (pra retry no proximo tick).
async function _clearJobMarkers(orderId, extraPatch) {
  await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
    video_brinde_job_id: null,
    video_brinde_started_at: null,
    ...(extraPatch || {}),
  });
}

// Gera o video de brinde pra UM pedido (idempotente).
// Flow:
//   1. Se ja tem video_brinde_url → return
//   2. Se ja tem video_brinde_job_id + started_at:
//      - se idade < STALE → retoma poll do job existente
//      - se idade >= STALE → abandona, marca pra recriar
//   3. Se nao tem job → cria novo, persiste job_id ANTES de pollar
//   4. Polla por 20min; se nao acabar, deixa job_id no DB pro proximo tick
async function generateBrindeForOrder(orderId, imageUrl) {
  if (!orderId || _running.has(orderId)) return;
  _running.add(orderId);
  try {
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,honoree_name,relationship,genre,story,original_audio_url,preview_audio_url,video_brinde_url,video_brinde_job_id,video_brinde_started_at,final_lyrics`);
    const o = Array.isArray(rows) && rows[0];
    if (!o || o.video_brinde_url) return;
    const audio = o.original_audio_url || o.preview_audio_url;
    if (!audio) return;

    let jobId = o.video_brinde_job_id || null;
    const startedAt = o.video_brinde_started_at ? new Date(o.video_brinde_started_at).getTime() : 0;
    const ageMs = startedAt ? Date.now() - startedAt : Infinity;

    // Job existente STALE → abandona pra recriar.
    if (jobId && ageMs >= STALE_JOB_MS) {
      console.warn(`[BrindeVideo] job ${jobId} stale (${Math.round(ageMs/60000)}min) p/ ${orderId} — abandonando`);
      await _clearJobMarkers(orderId);
      jobId = null;
    }

    // Job existente em janela viva → retoma poll.
    if (jobId) {
      console.log(`[BrindeVideo] retomando poll job ${jobId} (idade ${Math.round(ageMs/60000)}min) p/ ${orderId}`);
      const res = await _pollJob(jobId);
      if (res.done && res.url) {
        await _finalizeVideo(orderId, res.url);
        console.log(`[BrindeVideo] ✅ vídeo pronto p/ ${orderId}`);
        return;
      }
      if (res.failed) {
        console.warn(`[BrindeVideo] job ${jobId} FAILED p/ ${orderId} — limpa p/ retry`);
        await _clearJobMarkers(orderId);
        return;
      }
      // Ainda em progresso — proximo cron tick retoma.
      console.log(`[BrindeVideo] job ${jobId} segue em progresso p/ ${orderId}, proximo tick retoma`);
      return;
    }

    // Sem job → cria. Escolhe a capa por categoria (Pexels) ANTES de submeter —
    // evita imagem romântica em música infantil. Sem key/sem resultado → null
    // (video-api cai no default dele). imageUrl explícito (premium c/ foto) vence.
    let cover = imageUrl;
    if (!cover) cover = await _pexelsImage(_categoryQueries(o));
    console.log(`[BrindeVideo] criando novo job p/ ${orderId} (${o.honoree_name || '?'})${cover ? ' com capa' : ' so letra'}`);
    const newJobId = await _submitJob(audio, 'Para ' + (o.honoree_name || ''), cover, o.final_lyrics);
    if (!newJobId) {
      console.error(`[BrindeVideo] _submitJob retornou null p/ ${orderId}`);
      return;
    }
    // Persiste ANTES de pollar — evita race entre crons.
    await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
      video_brinde_job_id: newJobId,
      video_brinde_started_at: new Date().toISOString(),
    });
    console.log(`[BrindeVideo] job ${newJobId} criado p/ ${orderId}, polling ${Math.round(POLL_ITERATIONS*POLL_INTERVAL_MS/60000)}min`);
    const res = await _pollJob(newJobId);
    if (res.done && res.url) {
      await _finalizeVideo(orderId, res.url);
      console.log(`[BrindeVideo] ✅ vídeo pronto p/ ${orderId}`);
      return;
    }
    if (res.failed) {
      console.error(`[BrindeVideo] novo job ${newJobId} FAILED p/ ${orderId}`);
      await _clearJobMarkers(orderId);
      return;
    }
    console.log(`[BrindeVideo] job ${newJobId} ainda em progresso p/ ${orderId} — proximo tick retoma`);
  } catch (e) {
    console.error('[BrindeVideo] erro p/', orderId, e.message);
  } finally {
    _running.delete(orderId);
  }
}

// VIDEO PERSONALIZADO (premium com foto). Mesma logica de persistencia.
async function generatePersonalizedForOrder(orderId) {
  if (!orderId || _running.has(orderId)) return;
  _running.add(orderId);
  try {
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,honoree_name,original_audio_url,customer_photo_url,video_brinde_url,paid_at,video_brinde_job_id,video_brinde_started_at,final_lyrics`);
    const o = Array.isArray(rows) && rows[0];
    if (!o || !o.paid_at || !o.customer_photo_url || !o.original_audio_url) return;

    let jobId = o.video_brinde_job_id || null;
    const startedAt = o.video_brinde_started_at ? new Date(o.video_brinde_started_at).getTime() : 0;
    const ageMs = startedAt ? Date.now() - startedAt : Infinity;

    if (jobId && ageMs >= STALE_JOB_MS) {
      console.warn(`[PersonalizedVideo] job ${jobId} stale p/ ${orderId} — abandonando`);
      await _clearJobMarkers(orderId);
      jobId = null;
    }

    if (jobId) {
      console.log(`[PersonalizedVideo] retomando job ${jobId} p/ ${orderId}`);
      const res = await _pollJob(jobId);
      if (res.done && res.url) {
        await _finalizeVideo(orderId, res.url, { video_upsell_status: 'upsell_delivered', customer_photo_url: null });
        return;
      }
      if (res.failed) {
        await _clearJobMarkers(orderId, { video_upsell_status: 'photo_received' });
        return;
      }
      return; // em progresso
    }

    console.log(`[PersonalizedVideo] criando novo job (com foto) p/ ${orderId}`);
    const newJobId = await _submitJob(o.original_audio_url, 'Para ' + (o.honoree_name || ''), o.customer_photo_url, o.final_lyrics);
    if (!newJobId) return;
    await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
      video_brinde_job_id: newJobId,
      video_brinde_started_at: new Date().toISOString(),
    });
    const res = await _pollJob(newJobId);
    if (res.done && res.url) {
      await _finalizeVideo(orderId, res.url, { video_upsell_status: 'upsell_delivered', customer_photo_url: null });
    } else if (res.failed) {
      await _clearJobMarkers(orderId, { video_upsell_status: 'photo_received' });
    }
  } catch (e) {
    console.error('[PersonalizedVideo] erro:', e.message);
  } finally {
    _running.delete(orderId);
  }
}

// Cron de seguranca: pega pedidos com musica pronta sem video e gera/retoma.
//
// PRIORIZA ordens com job_id ja submetido (precisam de poll pra finalizar).
// Antes a cron filtrava `order=created_at.desc limit=4` e ordens antigas com
// job_id pendente ficavam orfas quando vinham novas (caso 13/jun: 164 orfaos
// com video pronto no video-api e URL nao salva no DB).
//
// Estrategia:
//   1) Primeiro: ate 8 ordens com video_brinde_job_id NOT NULL ordenadas por
//      video_brinde_started_at.asc (mais antigas primeiro) — precisam apenas
//      checar status no video-api e salvar URL quando done.
//   2) Depois: ate 4 ordens com video_brinde_job_id NULL ordenadas por
//      created_at.desc — precisam submeter job novo.
//   Premium legado: ate 2.
async function runBrindeGenOnce() {
  try {
    // MUDANCA 14/jun: filtro agora exige plano com video E paid_at NOT NULL.
    // Antes pegava preview_sent qualquer plano, gerando ~80% de videos pra cliente
    // que nem pagava — entupia a fila do video-api. Plano musica (R$19,90) NAO
    // recebe video em hipotese nenhuma.
    //
    // MUDANCA 15/jun: filtro `plan=eq.completa` virou `plan=in.(VIDEO_PLAN_KEYS)`
    // pra incluir promos com video (promo_namorados_2026, promo_recovery_jun26).
    // Fonte unica de verdade: payPlans.VIDEO_PLAN_KEYS_CSV.
    const { VIDEO_PLAN_KEYS_CSV } = require('./payPlans');
    const planFilter = `plan=in.(${VIDEO_PLAN_KEYS_CSV})`;
    //
    // Passo 1: jobs ja submetidos esperando poll/finalizacao.
    const pendingJobs = await supaFetch('GET', `orders?status=in.(paid,delivered)&${planFilter}&video_brinde_url=is.null&video_brinde_job_id=not.is.null&select=id&order=video_brinde_started_at.asc&limit=8`);
    await Promise.all((Array.isArray(pendingJobs) ? pendingJobs : []).map(o =>
      generateBrindeForOrder(o.id).catch(e => console.error('[BrindeVideo] poll-pending err:', o.id, e.message))
    ));
    // Passo 2: ordens pagas+video-plan novas precisando criar job.
    const newOnes = await supaFetch('GET', `orders?status=in.(paid,delivered)&${planFilter}&video_brinde_url=is.null&video_brinde_job_id=is.null&original_audio_url=not.is.null&select=id&order=paid_at.desc&limit=4`);
    await Promise.all((Array.isArray(newOnes) ? newOnes : []).map(o =>
      generateBrindeForOrder(o.id).catch(e => console.error('[BrindeVideo] new-order err:', o.id, e.message))
    ));
    // Passo 3: premium legado.
    const pend = await supaFetch('GET', `orders?video_upsell_status=eq.photo_received&customer_photo_url=not.is.null&video_brinde_url=is.null&select=id&order=paid_at.desc&limit=2`);
    await Promise.all((Array.isArray(pend) ? pend : []).map(o =>
      generatePersonalizedForOrder(o.id).catch(e => console.error('[PersonalizedVideo] order err:', o.id, e.message))
    ));
  } catch (e) { console.error('[BrindeVideo cron] erro:', e.message); }
}

function startBrindeGenCron() {
  if (_timer) return;
  const min = parseInt(process.env.BRINDE_GEN_INTERVAL_MIN || '4', 10);
  console.log(`[BrindeVideo] ✅ cron ON — ${min}min, poll persistente (20min/tick, stale 30min)`);
  setTimeout(() => { runBrindeGenOnce(); _timer = setInterval(runBrindeGenOnce, Math.max(1, min) * 60 * 1000); }, 45000);
}

module.exports = { generateBrindeForOrder, generatePersonalizedForOrder, runBrindeGenOnce, startBrindeGenCron };
