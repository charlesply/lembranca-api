// Cron do VÍDEO PERSONALIZADO (upsell R$14,90) — gera o vídeo COM a foto do cliente.
// Fluxo: order com video_upsell_status='photo_received' -> descriptografa a foto via
// Evolution -> sobe no Supabase Storage (público) -> gera o vídeo (image_url) -> envia ->
// DELETA a foto do Storage + limpa as refs no banco. Gated por UPSELL_VIDEO_ENABLED=true.
// try/catch — nunca derruba o server.

const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
const VIDEO_API = process.env.VIDEO_API_URL || 'http://video-suno-api.linkarbox.app';
const VIDEO_KEY = process.env.VIDEO_API_KEY || 'hc_7SPoyZxHpLwpxjyfWBwRdJB6Mpf75hvU08N9fhmzd-g';
const SUPA_KEY = process.env.SUPABASE_KEY || '';
const SUPA_STORAGE = (process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1').replace('/rest/v1', '') + '/storage/v1';
const BUCKET = 'customer-photos';

let _running = false;
let _timer = null;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function _fetchFotoBase64(phone, msgId) {
  const remoteJid = String(phone).includes('@') ? phone : phone + '@s.whatsapp.net';
  const r = await axios.post(`${EVO_URL}/chat/getBase64FromMediaMessage/${EVO_INSTANCE}`,
    { message: { key: { remoteJid, fromMe: false, id: msgId } } },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 30000 });
  let b64 = r.data && (r.data.base64 || (typeof r.data === 'string' ? r.data : null));
  if (!b64) return null;
  b64 = String(b64).replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(b64, 'base64');
}

async function _uploadStorage(name, buffer) {
  await axios.post(`${SUPA_STORAGE}/object/${BUCKET}/${name}`, buffer, {
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  return `${SUPA_STORAGE}/object/public/${BUCKET}/${name}`;
}

async function _deleteStorage(name) {
  try {
    await axios.delete(`${SUPA_STORAGE}/object/${BUCKET}/${name}`, { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY }, timeout: 15000 });
  } catch (e) { console.log('[UpsellVideo] delete storage falhou (ignorado):', e.message); }
}

async function _gerarVideo(audioUrl, imageUrl, title) {
  const body = new URLSearchParams({ audio_url: audioUrl, title: title, image_url: imageUrl }).toString();
  const g = await axios.post(`${VIDEO_API}/api/generate`, body, { headers: { 'X-API-Key': VIDEO_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
  const jobId = g.data && g.data.job_id;
  if (!jobId) return null;
  for (let i = 0; i < 24; i++) {
    await _sleep(10000);
    try {
      const j = await axios.get(`${VIDEO_API}/api/jobs/${jobId}`, { headers: { 'X-API-Key': VIDEO_KEY }, timeout: 15000 });
      if (j.data && j.data.status === 'done') return j.data.public_url || j.data.video_url;
      if (j.data && (j.data.status === 'error' || j.data.status === 'failed')) return null;
    } catch (e) {}
  }
  return null;
}

async function _enviarVideo(phone, url, honoree) {
  // vídeo primeiro, mensagem logo em seguida (separados)
  await axios.post(`${EVO_URL}/message/sendMedia/${EVO_INSTANCE}`, {
    number: phone, mediatype: 'video', media: url, fileName: 'VideoPersonalizado_' + (honoree || 'musica') + '.mp4',
  }, { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1500));
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    number: phone,
    text: '\u{1F389} Ficou PRONTO! Esse é o seu *vídeo personalizado* com a foto pra ' + (honoree || 'você') + ' \u{1F60D} É só compartilhar — vai ser um sucesso! \u{1F49C}',
  }, { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
}

async function runUpsellVideoOnce(reason = 'cron') {
  if (_running) { console.log('[UpsellVideo] tick ignorado (ja rodando)'); return { skipped: true }; }
  _running = true;
  try {
    const rows = await supaFetch('GET',
      `orders?video_upsell_status=eq.photo_received&original_audio_url=not.is.null&select=id,phone,honoree_name,original_audio_url,customer_photo_msg_id,customer_photo_url&limit=5`);
    const pend = Array.isArray(rows) ? rows : [];
    if (!pend.length) return { ok: true, pendentes: 0 };

    let entregues = 0;
    for (const o of pend) {
      if (!o.original_audio_url) continue;
      const fname = o.id + '-' + Date.now() + '.jpg';
      const fromSite = !!o.customer_photo_url; // foto veio do SITE (ja no storage)
      try {
        let imgUrl = null;
        if (fromSite) {
          imgUrl = o.customer_photo_url;
        } else if (o.phone && o.customer_photo_msg_id) {
          const buf = await _fetchFotoBase64(o.phone, o.customer_photo_msg_id);
          if (!buf || buf.length < 500) { console.error('[UpsellVideo] foto vazia/invalida:', o.id); continue; }
          imgUrl = await _uploadStorage(fname, buf);
        } else { continue; }
        const videoUrl = await _gerarVideo(o.original_audio_url, imgUrl, 'Para ' + (o.honoree_name || ''));
        // privacidade: apaga a foto do storage sempre que possivel
        try {
          if (fromSite) { const m = String(imgUrl).split('/customer-photos/')[1]; if (m) await _deleteStorage(m); }
          else { await _deleteStorage(fname); }
        } catch (_) {}
        if (videoUrl) {
          if (o.phone) { try { await _enviarVideo(o.phone, videoUrl, o.honoree_name); } catch (_) {} }
          await supaFetch('PATCH', `orders?id=eq.${o.id}`, { video_upsell_status: 'upsell_delivered', customer_photo_url: null, customer_photo_msg_id: null });
          entregues++;
          console.log(`[UpsellVideo] ✅ video personalizado entregue (${fromSite ? 'site' : 'whats'}) p/ ${o.id} (${o.honoree_name || '?'})`);
        } else {
          console.error('[UpsellVideo] geracao falhou (fica photo_received p/ retry):', o.id);
        }
      } catch (e) {
        console.error('[UpsellVideo] erro no pedido', o.id, e.message);
        if (!fromSite) { try { await _deleteStorage(fname); } catch (_) {} }
      }
      await _sleep(2000);
    }
    return { ok: true, pendentes: pend.length, entregues };
  } catch (e) {
    console.error('[UpsellVideo] erro (ignorado, server segue):', e.message);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
  }
}

function startUpsellVideoCron() {
  if (String(process.env.UPSELL_VIDEO_ENABLED).toLowerCase() !== 'true') {
    console.log('[UpsellVideo] desabilitado (UPSELL_VIDEO_ENABLED != true) — cron NAO iniciado');
    return;
  }
  if (_timer) return;
  const intervalMin = parseInt(process.env.UPSELL_VIDEO_INTERVAL_MIN || '2', 10);
  console.log(`[UpsellVideo] ✅ cron ON — a cada ${intervalMin}min`);
  setTimeout(() => {
    runUpsellVideoOnce('cron-boot');
    _timer = setInterval(() => runUpsellVideoOnce('cron'), Math.max(1, intervalMin) * 60 * 1000);
  }, 90000);
}

module.exports = { startUpsellVideoCron, runUpsellVideoOnce };
