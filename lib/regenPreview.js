// FUNDAÇÃO p/ refazer/repetir/grupo: cria um pedido com a historia+estilo dados,
// dispara a geração (generate_and_notify) e MARCA pra envio automatico da previa.
// Um cron envia a previa (como ARQUIVO = confiavel) + pergunta "gostou?" quando fica
// pronta, e marca pra nunca repetir. NAO toca no fluxo normal do bot.
// O endpoint /api/regen_and_send funciona sempre; o cron e gated por REGEN_PREVIEW_ENABLED=true.
const axios = require('axios');
const { supaFetch } = require('./supabase');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
const EVO_KEY = process.env.EVO_KEY || '';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';
const SELF = process.env.SELF_URL || 'https://api-suno.linkarbox.app';
const ENABLED = String(process.env.REGEN_PREVIEW_ENABLED).toLowerCase() === 'true';
const INTERVAL_MIN = Math.max(1, parseInt(process.env.REGEN_PREVIEW_INTERVAL_MIN || '1', 10));
let _timer = null, _running = false;

const _supaH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });

// Mapeia o estilo escolhido pelo cliente -> tags ricas pro Suno (bom timbre/instrumentos)
function styleToTags(style, voiceMale) {
  const s = (style || '').toLowerCase();
  const v = voiceMale ? 'male vocals' : 'female vocals';
  if (/pagode/.test(s)) return `Pagode, Romântico, Cavaquinho, Pandeiro, Violão, ${v}`;
  if (/sertanej/.test(s)) return `Sertanejo, Romântico, Violão, Viola Caipira, ${v}`;
  if (/gospel|adora/.test(s)) return `Gospel, Emotional, Piano, ${v}`;
  if (/mpb/.test(s)) return `MPB, Acoustic Guitar, Suave, ${v}`;
  if (/forr[óo]/.test(s)) return `Forró, Animado, Sanfona, Triângulo, ${v}`;
  if (/funk/.test(s)) return `Funk, Batida, ${v}`;
  if (/rap|hip/.test(s)) return `Rap, Hip Hop, Beat, ${v}`;
  if (/rock/.test(s)) return `Rock, Guitarra, ${v}`;
  if (/pop/.test(s)) return `Pop, Romântico, ${v}`;
  // fallback: usa o estilo cru + voz
  return `${style || 'Romântico'}, ${v}`;
}

async function _mark(orderId, value) {
  try {
    await axios.post(`${SUPABASE_URL}/system_control`,
      { key: `autosend_${orderId}`, value, updated_by: 'regenPreview' },
      { headers: { ..._supaH(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' } });
  } catch (e) {}
}
async function _markStatus(orderId) {
  try {
    const r = await axios.get(`${SUPABASE_URL}/system_control?key=eq.autosend_${orderId}&select=value`, { headers: _supaH() });
    return (Array.isArray(r.data) && r.data[0]) ? r.data[0].value : null;
  } catch (e) { return null; }
}

// Cria pedido + dispara geração + marca pra auto-envio
async function regenAndSend({ phone, honoreeName, relationship, story, style, voice, mood, occasion }) {
  if (!phone || !story || story.trim().length < 10) throw new Error('phone e story (>10) obrigatorios');
  const voiceMale = !/fem|mulher/i.test(voice || '');
  const created = await supaFetch('POST', 'orders', {
    phone, honoree_name: honoreeName || 'Especial', relationship: relationship || '',
    story, style_raw: style || 'Romântico', voice_preference: voice || (voiceMale ? 'Masculina' : 'Feminina'),
    status: 'generating',
  });
  const order = Array.isArray(created) ? created[0] : created;
  if (!order || !order.id) throw new Error('falha ao criar pedido');
  await _mark(order.id, 'pending');
  const tags = styleToTags(style, voiceMale);
  await axios.post(`${SELF}/api/generate_and_notify`, {
    story, tags, title: 'Para ' + (honoreeName || 'você'), model: 'chirp-fenix', make_instrumental: false,
    honoreeName: honoreeName || '', relationship: relationship || '', mood: mood || '', voice: voice || '',
    vocal_gender: voiceMale ? 'm' : 'f', phone, orderId: order.id,
  }, { timeout: 20000 });
  console.log(`[regenPreview] regen disparado | order ${order.id} | ${honoreeName} | tags: ${tags}`);
  return { orderId: order.id, tags };
}

async function _sendText(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, { number: phone, text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 30000 });
}
async function _sendAudioBuf(phone, buf) {
  await axios.post(`${EVO_URL}/message/sendMedia/${EVO_INSTANCE}`,
    { number: phone, mediatype: 'audio', mimetype: 'audio/mpeg', fileName: 'Previa.mp3', media: Buffer.from(buf).toString('base64') },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 120000 });
}

// Cron: envia a previa dos pedidos marcados 'pending' que ja tem previa pronta
async function runPreviewSenderOnce(reason = 'cron') {
  if (_running) return { skipped: true };
  _running = true;
  let enviados = 0;
  try {
    const cutoff = new Date(Date.now() - 3 * 3600000).toISOString();
    const orders = await supaFetch('GET', `orders?created_at=gt.${cutoff}&preview_audio_url=not.is.null&select=id,phone,honoree_name,preview_audio_url&order=created_at.desc&limit=30`) || [];
    const _sentPhones = new Set();
    for (const o of orders) {
      if (!o.phone || !o.preview_audio_url) continue;
      if (await _markStatus(o.id) !== 'pending') continue;
      // DEDUP POR CLIENTE: nunca 2 previas pro mesmo numero (mesmo run, ou irmao preview_sent recente).
      const _ph = String(o.phone).replace(/\D/g, '');
      if (_sentPhones.has(_ph)) { await _mark(o.id, 'sent'); continue; }
      try {
        const _recent = new Date(Date.now() - 30 * 60000).toISOString();
        const _sib = await supaFetch('GET', `orders?phone=eq.${o.phone}&status=in.(preview_sent,paid,delivered,completed)&id=neq.${o.id}&created_at=gte.${_recent}&select=id&limit=1`);
        if (Array.isArray(_sib) && _sib.length) { console.log('[regenPreview] dedup: ' + o.phone + ' ja recebeu previa recente — pulando ' + o.id); await _mark(o.id, 'sent'); _sentPhones.add(_ph); continue; }
      } catch (e) {}
      try {
        await _sendText(o.phone, '🎶 Prontinho, ficou pronta! 🥹 Olha a prévia da música pra ' + (o.honoree_name || 'você') + ':');
        await new Promise(r => setTimeout(r, 1500));
        const bin = await axios.get(o.preview_audio_url, { responseType: 'arraybuffer', timeout: 60000 });
        await _sendAudioBuf(o.phone, bin.data);
        await new Promise(r => setTimeout(r, 1500));
        await _sendText(o.phone, '🎵 E aí, gostou? Me conta o que achou! 💜');
        await supaFetch('PATCH', `orders?id=eq.${o.id}`, { status: 'preview_sent' });
        await _mark(o.id, 'sent');
        _sentPhones.add(_ph);
        enviados++;
        console.log('[regenPreview] previa enviada p/', o.phone, '(' + (o.honoree_name || '?') + ')');
      } catch (e) { console.error('[regenPreview] envio falhou:', o.id, e.message); }
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (e) { console.error('[regenPreview] erro (ignorado):', e.message); }
  _running = false;
  return { ok: true, enviados };
}

function startPreviewSenderCron() {
  if (_timer) return;
  if (!ENABLED) { console.log('[regenPreview] cron desabilitado (REGEN_PREVIEW_ENABLED != true)'); return; }
  console.log(`[regenPreview] ✅ cron ON — envia previas auto a cada ${INTERVAL_MIN}min`);
  setTimeout(() => { runPreviewSenderOnce('cron').catch(() => {}); _timer = setInterval(() => runPreviewSenderOnce('cron').catch(() => {}), INTERVAL_MIN * 60000); }, 60000);
}

module.exports = { regenAndSend, runPreviewSenderOnce, startPreviewSenderCron, styleToTags };
