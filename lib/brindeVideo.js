// Geração do VÍDEO DE BRINDE (vídeo com a letra) pro fluxo do SITE — replica a lógica do n8n,
// mas SEM depender do n8n. Chama a API de vídeo (video-suno-api) com audio_url + title,
// faz poll do job e grava video_brinde_url no pedido. O chat do site faz poll e mostra quando pronto.
const axios = require('axios');
const { supaFetch } = require('./supabase');

const VIDEO_API = process.env.VIDEO_API_URL || 'http://video-suno-api.linkarbox.app';
const VIDEO_KEY = process.env.VIDEO_API_KEY || 'hc_7SPoyZxHpLwpxjyfWBwRdJB6Mpf75hvU08N9fhmzd-g';
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _running = new Set();
let _timer = null;

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
  try {
    const STORAGE_BASE = SUPA_URL.replace('/rest/v1', '') + '/storage/v1';
    const BUCKET = 'videos';
    const filename = externalUrl.split('/').pop().split('?')[0];
    if (!filename || !filename.endsWith('.mp4')) {
      console.warn('[BrindeVideo] filename inesperado, mantendo URL externa:', filename);
      return externalUrl;
    }
    // Download — passa X-API-Key SE a URL é da video-suno-api (endpoint
    // /api/jobs/{id}/video exige auth). Pra URLs públicas (S3, Supabase
    // do amigo, etc.) o header extra é ignorado e não atrapalha.
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
    // Sanity check: arquivo < 1KB provavelmente é mensagem de erro JSON
    // (unauthorized, not found). Não salva, joga pra catch outer.
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

// Dispara a geração e faz poll até ficar pronto (~até 5min). Retorna a URL do vídeo ou null.
// imageUrl opcional = vídeo PERSONALIZADO com a foto; sem ela = vídeo com a letra (brinde).
async function _gerar(audioUrl, title, imageUrl) {
  const params = { audio_url: audioUrl, title: title };
  if (imageUrl) params.image_url = imageUrl;
  const body = new URLSearchParams(params).toString();
  const g = await axios.post(`${VIDEO_API}/api/generate`, body, {
    headers: { 'X-API-Key': VIDEO_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000,
  });
  const jobId = g.data && g.data.job_id;
  if (!jobId) return null;
  for (let i = 0; i < 30; i++) {
    await _sleep(10000);
    try {
      const j = await axios.get(`${VIDEO_API}/api/jobs/${jobId}`, { headers: { 'X-API-Key': VIDEO_KEY }, timeout: 15000 });
      if (j.data && j.data.status === 'done') return j.data.public_url || j.data.video_url;
      if (j.data && (j.data.status === 'error' || j.data.status === 'failed')) return null;
    } catch (_) {}
  }
  return null;
}

// Gera o vídeo pra UM pedido (idempotente, fire-and-forget).
//
// MUDANCA IMPORTANTE: antes esse video so era gerado APOS o pagamento (gate
// !o.paid_at). Agora geramos LOGO QUE A MUSICA FICA PRONTA — usando a capa
// que o Suno ja produziu (image_url) como background do karaoke. Assim,
// quando o cliente paga o plano R$29,90, a entrega do video e INSTANTANEA.
//
// `imageUrl` opcional (recomendado: passar a capa do Suno). Sem ela, o video
// e gerado so com a letra (estilo simples).
async function generateBrindeForOrder(orderId, imageUrl) {
  if (!orderId || _running.has(orderId)) return;
  _running.add(orderId);
  try {
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,honoree_name,original_audio_url,preview_audio_url,video_brinde_url`);
    const o = Array.isArray(rows) && rows[0];
    if (!o || o.video_brinde_url) return;                        // ja tem video
    const audio = o.original_audio_url || o.preview_audio_url;
    if (!audio) return;
    console.log(`[BrindeVideo] gerando p/ ${orderId} (${o.honoree_name || '?'})${imageUrl ? ' com capa Suno' : ' so letra'}`);
    const externalUrl = await _gerar(audio, 'Para ' + (o.honoree_name || ''), imageUrl);
    if (externalUrl) {
      const videoUrl = await _rehostVideoToMySupabase(externalUrl);
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, { video_brinde_url: videoUrl });
      console.log(`[BrindeVideo] ✅ vídeo pronto p/ ${orderId}`);
    } else {
      console.error(`[BrindeVideo] geração falhou p/ ${orderId}`);
    }
  } catch (e) {
    console.error('[BrindeVideo] erro p/', orderId, e.message);
  } finally {
    _running.delete(orderId);
  }
}

// VÍDEO PERSONALIZADO (premium) — gera COM a foto do cliente e grava em video_brinde_url.
// Disparado no upload da foto. Apaga a foto depois (privacidade).
async function generatePersonalizedForOrder(orderId) {
  if (!orderId || _running.has(orderId)) return;
  _running.add(orderId);
  try {
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,honoree_name,original_audio_url,customer_photo_url,video_brinde_url,paid_at`);
    const o = Array.isArray(rows) && rows[0];
    if (!o || !o.paid_at || !o.customer_photo_url || !o.original_audio_url) return;
    console.log(`[PersonalizedVideo] gerando p/ ${orderId} (com foto)`);
    const externalUrl = await _gerar(o.original_audio_url, 'Para ' + (o.honoree_name || ''), o.customer_photo_url);
    if (externalUrl) {
      const videoUrl = await _rehostVideoToMySupabase(externalUrl);
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, { video_brinde_url: videoUrl, video_upsell_status: 'upsell_delivered', customer_photo_url: null });
      console.log(`[PersonalizedVideo] ✅ vídeo personalizado pronto p/ ${orderId}`);
    } else {
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, { video_upsell_status: 'photo_received' }); // permite retry
      console.error(`[PersonalizedVideo] geração falhou p/ ${orderId}`);
    }
  } catch (e) {
    console.error('[PersonalizedVideo] erro:', e.message);
  } finally {
    _running.delete(orderId);
  }
}

// Cron de SEGURANÇA: pega pedidos COM MUSICA pronta SEM vídeo e gera.
// Antes so processava pedidos PAGOS. Agora pre-gera pra TODOS os preview_sent
// (cobre o caso do trigger imediato no Inngest falhar). Retomada de fotos
// pendentes (premium legado) tambem segue.
async function runBrindeGenOnce() {
  try {
    // Pre-gerar video pra QUALQUER pedido com original_audio_url e sem video.
    // Limite 2 por tick = nao sobrecarrega a video API.
    const rows = await supaFetch('GET', `orders?status=in.(preview_sent,paid,delivered)&video_brinde_url=is.null&original_audio_url=not.is.null&select=id&order=created_at.desc&limit=2`);
    for (const o of (Array.isArray(rows) ? rows : [])) {
      await generateBrindeForOrder(o.id); // sequencial — não sobrecarrega a API de vídeo
    }
    // premium legado: fotos recebidas aguardando geração do vídeo personalizado
    const pend = await supaFetch('GET', `orders?video_upsell_status=eq.photo_received&customer_photo_url=not.is.null&video_brinde_url=is.null&select=id&order=paid_at.desc&limit=2`);
    for (const o of (Array.isArray(pend) ? pend : [])) {
      await generatePersonalizedForOrder(o.id);
    }
  } catch (e) { console.error('[BrindeVideo cron] erro:', e.message); }
}

function startBrindeGenCron() {
  if (_timer) return;
  const min = parseInt(process.env.BRINDE_GEN_INTERVAL_MIN || '4', 10);
  console.log(`[BrindeVideo] ✅ cron de geração ON — a cada ${min}min`);
  setTimeout(() => { runBrindeGenOnce(); _timer = setInterval(runBrindeGenOnce, Math.max(1, min) * 60 * 1000); }, 45000);
}

module.exports = { generateBrindeForOrder, generatePersonalizedForOrder, runBrindeGenOnce, startBrindeGenCron };
