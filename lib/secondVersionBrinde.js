// Cron 2a VERSAO + INDICACAO — ~Nh depois da entrega, manda a 2a versao da musica
// (de brinde, como ARQUIVO base64 = confiavel) + pede indicacao com desconto.
// Marca em system_control (ver2_<id>) pra nunca repetir. NAO toca no fluxo principal.
// Gated por SECOND_VERSION_ENABLED=true. Tem dry-run. try/catch em tudo.
const axios = require('axios');
const { supaFetch } = require('./supabase');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
const EVO_KEY = process.env.EVO_KEY || '';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';
const DELAY_H = parseFloat(process.env.SECOND_VERSION_DELAY_H || '3');       // espera apos a entrega
const LOOKBACK_H = parseFloat(process.env.SECOND_VERSION_LOOKBACK_H || '12'); // janela maxima (evita backlog gigante)
const INTERVAL_MIN = Math.max(10, parseInt(process.env.SECOND_VERSION_INTERVAL_MIN || '30', 10));
const ENABLED = String(process.env.SECOND_VERSION_ENABLED).toLowerCase() === 'true';
let _timer = null, _running = false;

const _supaH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });

const TXT_INTRO = '🎁 Ô, deixa eu te surpreender mais uma vez... 🥹\n\nToda música nossa nasce em *2 versões* — tô te mandando a *2ª* aqui também, *de brinde*, só porque você merece! 💜';
const TXT_INDICA = 'E se a música tocou seu coração... me faz um carinho? 🥹\n\n*Indica a Lembrança Cantada* pra um amigo ou familiar que ama alguém especial. Quem vier por você ganha um *desconto especial* comigo 💝 — é só mandar o contato ou pedir pra te chamarem aqui! ✨';

async function _sendText(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, { number: phone, text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 30000 });
}
async function _sendAudioArquivo(phone, url) {
  const bin = await axios.get(url, { responseType: 'arraybuffer', timeout: 90000 });
  const b64 = Buffer.from(bin.data).toString('base64');
  await axios.post(`${EVO_URL}/message/sendMedia/${EVO_INSTANCE}`,
    { number: phone, mediatype: 'audio', mimetype: 'audio/mpeg', fileName: 'Musica_2a_versao.mp3', media: b64 },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 120000 });
}
async function _jaEnviou(orderId) {
  try {
    const r = await axios.get(`${SUPABASE_URL}/system_control?key=eq.ver2_${orderId}&select=key`, { headers: _supaH() });
    return Array.isArray(r.data) && r.data.length > 0;
  } catch (e) { return true; } // erro -> trata como ja enviado (nao manda duplicado por engano)
}
async function _marcar(orderId) {
  try {
    await axios.post(`${SUPABASE_URL}/system_control`,
      { key: `ver2_${orderId}`, value: new Date().toISOString(), updated_by: 'secondVersion' },
      { headers: { ..._supaH(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' } });
  } catch (e) {}
}

// Horário de silêncio: NUNCA envia fora do horário comercial (Brasília). Default 08h–21h.
function _isQuietHours() {
  const startH = parseInt(process.env.OUTBOUND_START_HOUR || '8', 10);
  const endH = parseInt(process.env.OUTBOUND_END_HOUR || '21', 10);
  const brHour = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
  return brHour < startH || brHour >= endH;
}

async function runSecondVersionOnce(reason = 'cron', dryRun = false) {
  if (_running && !dryRun) return { skipped: true };
  if (reason !== 'manual' && !dryRun && _isQuietHours()) {
    console.log('[secondVersion] horário de silêncio (fora 08h–21h BR) — pulando tick');
    return { skipped: 'horario_silencio' };
  }
  _running = true;
  const enviados = [], candidatos = [];
  try {
    const cutoff = new Date(Date.now() - DELAY_H * 3600000).toISOString();
    const lookback = new Date(Date.now() - LOOKBACK_H * 3600000).toISOString();
    const rows = await supaFetch('GET', `orders?status=in.(paid,delivered,completed)&paid_at=lt.${cutoff}&paid_at=gt.${lookback}&select=id,phone,honoree_name,full_audio_urls&order=paid_at.desc&limit=50`) || [];
    for (const o of rows) {
      if (!o.phone || !o.full_audio_urls || o.full_audio_urls.length < 2) continue;
      if (await _jaEnviou(o.id)) continue;
      candidatos.push({ phone: o.phone, honoree: o.honoree_name });
      if (dryRun) continue;
      try {
        await _sendText(o.phone, TXT_INTRO);
        await new Promise(r => setTimeout(r, 1500));
        await _sendAudioArquivo(o.phone, o.full_audio_urls[1]);
        await new Promise(r => setTimeout(r, 1500));
        await _sendText(o.phone, TXT_INDICA);
        await _marcar(o.id);
        enviados.push(o.phone);
        console.log(`[secondVersion] 2a versao + indicacao enviada p/ ${o.phone} (${o.honoree_name || '?'})`);
      } catch (e) { console.error('[secondVersion] envio falhou:', o.id, e.message); }
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) { console.error('[secondVersion] erro (ignorado):', e.message); }
  _running = false;
  return { ok: true, dryRun, delayH: DELAY_H, lookbackH: LOOKBACK_H, candidatos: candidatos.length, lista: candidatos.slice(0, 20), enviados: enviados.length };
}

function startSecondVersionCron() {
  if (_timer) return;
  if (!ENABLED) { console.log('[secondVersion] desabilitado (SECOND_VERSION_ENABLED != true) — cron NAO iniciado'); return; }
  console.log(`[secondVersion] ✅ cron ON — 2a versao + indicacao ~${DELAY_H}h apos entrega (check a cada ${INTERVAL_MIN}min)`);
  setTimeout(() => {
    runSecondVersionOnce('cron').catch(() => {});
    _timer = setInterval(() => runSecondVersionOnce('cron').catch(() => {}), INTERVAL_MIN * 60000);
  }, 90000);
}

module.exports = { runSecondVersionOnce, startSecondVersionCron };
