// Cron do VÍDEO DE BRINDE — envia o MP4 (já gerado e guardado em video_brinde_url) como
// SURPRESA depois que o cliente RESPONDE ao agradecimento. Se ele não responder em
// VIDEO_BRINDE_FALLBACK_MIN (default 20min), envia mesmo assim (é brinde pago = garantia).
// Gated por VIDEO_BRINDE_ENABLED=true. try/catch — nunca derruba o server.

const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
const EVO_KEY = process.env.EVO_KEY || '';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';
const FALLBACK_MIN = parseInt(process.env.VIDEO_BRINDE_FALLBACK_MIN || '20', 10);

let _running = false;
let _timer = null;

async function _clienteRespondeu(phone, sinceISO) {
  try {
    const r = await supaFetch('GET',
      `conversations?phone=eq.${phone}&role=eq.user&created_at=gt.${encodeURIComponent(sinceISO)}&content=not.like.__STATE__*&select=id&limit=1`);
    return Array.isArray(r) && r.length > 0;
  } catch (e) { return false; }
}

async function _enviarVideo(phone, url, honoree) {
  // vídeo primeiro, mensagem logo em seguida (separados)
  await axios.post(`${EVO_URL}/message/sendMedia/${EVO_INSTANCE}`, {
    number: phone,
    mediatype: 'video',
    media: url,
    fileName: 'Video_' + (honoree || 'musica') + '.mp4',
  }, { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    number: phone,
    text: '\u{1F381} Esse é o seu *vídeo de brinde* da música pra ' + (honoree || 'você') + '! É só compartilhar nas redes \u{1F3AC}\u{1F49C}',
  }, { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
}

async function _enviarOfertaUpsell(phone, honoree) {
  const nome = honoree || 'essa pessoa especial';
  const msg =
    '\u{1F92B} Ó, deixa eu te contar um segredo...\n\n' +
    'Esse vídeo já tá lindo — mas dá pra deixar ele *INESQUECÍVEL*. \u{1F979}\n\n' +
    'Imagina a *FOTO de vocês* (ou da *' + nome + '*) aparecendo no vídeo, com o nome dela e a música tocando... É o tipo de coisa que ela vai *guardar pra sempre* e mostrar pra todo mundo! \u{1F4F2}✨\n\n' +
    'Quem faz isso conta que a reação é de *chorar* — e quase todo mundo posta nas redes marcando a gente \u{1F49C}\n\n' +
    'Por *só R$ 14,90* eu personalizo o vídeo com a sua foto. Bora deixar perfeito?\n\n' +
    '✨ *EU QUERO surpreender ' + nome + '!* \u{1F381}\n' +
    '\u{1F614} Não quero agradar tanto ' + nome;
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    number: phone, text: msg,
  }, { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
}

// Horário de silêncio: NUNCA envia fora do horário comercial (Brasília). Default 08h–21h.
function _isQuietHours() {
  const startH = parseInt(process.env.OUTBOUND_START_HOUR || '8', 10);
  const endH = parseInt(process.env.OUTBOUND_END_HOUR || '21', 10);
  const brHour = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
  return brHour < startH || brHour >= endH;
}

async function runVideoBrindeOnce(reason = 'cron') {
  if (_running) { console.log('[VideoBrinde] tick ignorado (ja rodando)'); return { skipped: true }; }
  if (reason !== 'manual' && _isQuietHours()) {
    console.log('[VideoBrinde] horário de silêncio (fora 08h–21h BR) — pulando tick');
    return { skipped: 'horario_silencio' };
  }
  _running = true;
  try {
    const rows = await supaFetch('GET',
      `orders?video_brinde_url=not.is.null&video_brinde_sent_at=is.null&paid_at=not.is.null&select=id,phone,honoree_name,delivered_at,video_brinde_url,video_upsell_status,paid_at&order=delivered_at.asc&limit=20`);
    const pend = Array.isArray(rows) ? rows : [];
    if (!pend.length) { return { ok: true, pendentes: 0 }; }

    let enviados = 0;
    for (const o of pend) {
      if (!o.phone || !o.video_brinde_url) continue;
      // SEGURANCA: SÓ envia o brinde (perk PAGO) pra pedido realmente PAGO e nao-teste/nao-admin.
      if (!o.paid_at) continue;
      const _nm = String(o.honoree_name || '').toLowerCase();
      const _ph = String(o.phone || '').replace(/\D/g, '');
      if (_nm.includes('test') || _nm.includes('seguranc') || _ph.endsWith('912589669') || _ph.length < 10) continue;
      const deliveredMs = o.delivered_at ? new Date(o.delivered_at).getTime() : 0;
      const ageMin = deliveredMs ? (Date.now() - deliveredMs) / 60000 : 999;
      const respondeu = deliveredMs ? await _clienteRespondeu(o.phone, o.delivered_at) : true;
      if (respondeu || ageMin >= FALLBACK_MIN) {
        try {
          await _enviarVideo(o.phone, o.video_brinde_url, o.honoree_name);
          await supaFetch('PATCH', `orders?id=eq.${o.id}`, { video_brinde_sent_at: new Date().toISOString() });
          enviados++;
          console.log(`[VideoBrinde] ✅ enviado p/ ${o.phone} (${o.honoree_name || '?'}) — ${respondeu ? 'cliente respondeu' : 'fallback ' + Math.round(ageMin) + 'min'}`);
          // UPSELL PROATIVO: logo após o vídeo de brinde, oferece a versão personalizada
          // com foto (R$14,90). Só se ainda não foi oferecido. O aceite/PIX é tratado
          // pelo fluxo de UPSELL que já existe na Maquina de Estados.
          if (!o.video_upsell_status && String(process.env.UPSELL_ENABLED).toLowerCase() === 'true') {
            try {
              await new Promise((r) => setTimeout(r, 2500));
              await _enviarOfertaUpsell(o.phone, o.honoree_name);
              await supaFetch('PATCH', `orders?id=eq.${o.id}`, { video_upsell_status: 'offered' });
              console.log(`[VideoBrinde] 🎬 oferta de upsell enviada p/ ${o.phone}`);
            } catch (e) { console.error('[VideoBrinde] oferta upsell falhou:', e.message); }
          }
          await new Promise((r) => setTimeout(r, 1500));
        } catch (e) { console.error('[VideoBrinde] envio falhou:', o.id, e.message); }
      }
    }
    return { ok: true, pendentes: pend.length, enviados };
  } catch (e) {
    console.error('[VideoBrinde] erro (ignorado, server segue):', e.message);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
  }
}

function startVideoBrindeCron() {
  if (String(process.env.VIDEO_BRINDE_ENABLED).toLowerCase() !== 'true') {
    console.log('[VideoBrinde] desabilitado (VIDEO_BRINDE_ENABLED != true) — cron NAO iniciado');
    return;
  }
  if (_timer) return;
  const intervalMin = parseInt(process.env.VIDEO_BRINDE_INTERVAL_MIN || '2', 10);
  console.log(`[VideoBrinde] ✅ cron ON — a cada ${intervalMin}min (fallback ${FALLBACK_MIN}min)`);
  setTimeout(() => {
    runVideoBrindeOnce('cron-boot');
    _timer = setInterval(() => runVideoBrindeOnce('cron'), Math.max(1, intervalMin) * 60 * 1000);
  }, 60000);
}

module.exports = { startVideoBrindeCron, runVideoBrindeOnce };
