// FUNIL DE RECUPERAÇÃO — recupera LEADS QUENTES (receberam a prévia grátis e não pagaram).
// Manda mensagens de recuperação escalonadas (R1 +nudge, R2 lembrete, R3 última chance) pela
// mesma instância do Evolution/Bia, pra continuar na mesma conversa do WhatsApp.
// Rastreia tudo em funnel_events (event_type='recovery_1/2/3') — SEM precisar de coluna nova.
//
// TRAVAS DE SEGURANÇA (importante — mexe com clientes reais):
//   RECOVERY_ENABLED=true   -> liga o cron automático (default OFF: deploy não dispara nada)
//   RECOVERY_TEST_PHONE=...  -> se setado, SÓ esse telefone recebe (teste de 1 lead)
//   RECOVERY_DRY_RUN=true   -> loga quem receberia, NÃO envia
//   RECOVERY_MAX_PER_RUN=8  -> teto de mensagens por execução (anti-spam / anti-ban)
//   RECOVERY_INTERVAL_MIN=60 -> intervalo do cron
// Respeita: bot_paused_phones (humano assumiu), opt-out, máx 3 tentativas, gap entre mensagens.
const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
const EVO_KEY = process.env.EVO_KEY || '';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';

const MAX_ATTEMPTS = 3;
const PRICE = 'R$19,90';
// Funil só recupera leads cuja prévia foi enviada A PARTIR desta data (decisão do dono:
// "começar o funil a partir de hoje"). Evita backlog antigo / já-entregues-manual / leads frios.
const RECOVERY_SINCE = process.env.RECOVERY_SINCE || '2026-05-31';
// gap mínimo (horas) desde a ÚLTIMA recuperação pra mandar a próxima
const GAP_HOURS = { 1: 1, 2: 22, 3: 46 }; // R1: 1h após prévia; R2: ~1 dia; R3: ~2 dias
const TEST_PHONES = new Set(['11915391862', '5511915391862', '11915301862', '5511915301862']);

let _timer = null;
let _running = false;

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _digits = (p) => String(p || '').replace(/\D/g, '');

// normaliza telefone BR (10/11 dígitos -> prefixa 55). Mantém internacionais (ex: 351...).
function _normPhone(p) {
  const d = _digits(p);
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return '55' + d; // DDD + numero local
  return d;
}

// é lixo/teste? (não recuperar)
function _isJunk(o) {
  const name = String(o.honoree_name || '').toLowerCase();
  const d = _digits(o.phone);
  if (!d || d.length < 10) return true;
  if (TEST_PHONES.has(d)) return true;
  if (name.includes('teste') || name.includes('test ') || name === 'test') return true;
  if (!o.honoree_name || o.honoree_name.trim().length < 2) return true;
  return false;
}

// palavras que NÃO são nome (parse ruim do n8n: pegou frase em vez do nome)
const _STOP = new Set(['chama', 'queria', 'quero', 'moramos', 'moro', 'gosto', 'amo', 'ela', 'ele',
  'namorar', 'namoro', 'conheci', 'somos', 'sou', 'faz', 'tenho', 'minha', 'meu', 'minha', 'para',
  'pra', 'que', 'uma', 'um', 'com', 'sem', 'era', 'eh', 'aniversario', 'casamento', 'esposa',
  'esposo', 'marido', 'mae', 'pai', 'filho', 'filha', 'amiga', 'amigo', 'amor', 'vida', 'dela', 'dele']);

// extrai um nome de verdade do honoree_name; null se for lixo/frase
function _cleanName(raw) {
  if (!raw) return null;
  const words = String(raw).trim().split(/\s+/);
  for (const w of words) {
    const bare = w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (_STOP.has(bare)) continue;
    if (!/^[a-zà-úA-ZÀ-Ú]{2,15}$/.test(w)) continue;        // só letras, 2-15
    if (w[0] !== w[0].toUpperCase()) continue;               // começa maiúsculo
    return w;
  }
  return null; // nenhum token parece nome -> usa frase genérica
}

// SEM nome do homenageado de propósito: no WhatsApp o honoree_name às vezes vem com emoji,
// frase ou parse ruim ("Queria namorar ela") — usar genérico é seguro pra todo mundo.
function _msg(attempt) {
  if (attempt === 1) {
    return `Oi! 💜 Aqui é a Bia da *Lembrança Cantada*. Vi que você criou a prévia da sua música mas não chegou a liberar a versão completa 🥺\n\nO que você achou da prévia? Se curtiu, por só *${PRICE}* eu libero a música *completa* + um *vídeo de brinde* com a letra 🎵\n\nQuer que eu prepare? 😊`;
  }
  if (attempt === 2) {
    return `Oi de novo! 😊 A sua música ainda tá aqui guardadinha esperando você 🎵\n\nImagina a reação de quem vai receber essa homenagem... Por *${PRICE}* eu libero a completa + o vídeo de brinde.\n\nBora fazer acontecer? 💜`;
  }
  return `Última chamada 💜 A sua música vai sair da minha fila em breve e seria uma pena perder essa homenagem que ficou tão linda 🥺\n\nQuer garantir? É só *${PRICE}* — responde aqui que eu cuido de todo o resto pra você 🎵`;
}

async function _isPaused(phone) {
  const d = _digits(phone);
  // tenta algumas variantes do telefone
  for (const v of [d, '55' + d, d.replace(/^55/, '')]) {
    if (!v) continue;
    const r = await supaFetch('GET', `bot_paused_phones?phone=eq.${encodeURIComponent(v)}&select=phone&limit=1`);
    if (Array.isArray(r) && r.length) return true;
  }
  return false;
}

// Tracking de recuperação no funnel_events. O CHECK constraint da tabela só aceita uma lista
// fixa de event_type, então usamos 'abandoned_at_preview' (que o n8n NÃO emite) como marcador,
// distinguindo recuperação por metadata.recovery=true + metadata.attempt. Conta/dedup confiáveis.
const REC_EVENT = 'abandoned_at_preview';

// conta recuperações já enviadas + última data (a partir do funnel_events)
async function _recoveryHistory(orderId) {
  const rows = await supaFetch('GET', `funnel_events?order_id=eq.${orderId}&event_type=eq.${REC_EVENT}&select=metadata,created_at&order=created_at.desc`);
  if (!Array.isArray(rows) || !rows.length) return { attempts: 0, lastAt: null, optedOut: false };
  const recs = rows.filter((r) => r.metadata && r.metadata.recovery === true);
  const optedOut = recs.some((r) => r.metadata && r.metadata.optout === true);
  const sends = recs.filter((r) => r.metadata && r.metadata.sent === true);
  return { attempts: sends.length, lastAt: sends[0] ? sends[0].created_at : null, optedOut };
}

async function _logEvent(orderId, phone, attempt, message, sent) {
  await supaFetch('POST', 'funnel_events', {
    order_id: orderId,
    phone: _digits(phone),
    event_type: REC_EVENT,
    step_number: attempt,
    metadata: { recovery: true, attempt, sent, message: message.slice(0, 300), at: new Date().toISOString() },
  });
}

async function _sendText(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    number: _normPhone(phone), text,
  }, { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
}

// decide qual mensagem (se alguma) esse lead deve receber agora
function _decide(history, previewSentAt, nowMs) {
  if (history.optedOut) return null;
  if (history.attempts >= MAX_ATTEMPTS) return null;
  const nextAttempt = history.attempts + 1;
  const refTime = history.lastAt ? new Date(history.lastAt).getTime() : new Date(previewSentAt).getTime();
  const hoursSince = (nowMs - refTime) / 3600000;
  const need = GAP_HOURS[nextAttempt] || 24;
  if (hoursSince < need) return null; // ainda não é hora
  return nextAttempt;
}

// Roda UMA passada do funil. opts: { dryRun, testPhone, maxPerRun, onlyPhone }
async function runRecoveryOnce(opts = {}) {
  if (_running) return { skipped: 'já rodando' };
  _running = true;
  const dryRun = opts.dryRun != null ? opts.dryRun : (process.env.RECOVERY_DRY_RUN === 'true');
  const testPhone = opts.testPhone != null ? opts.testPhone : (process.env.RECOVERY_TEST_PHONE || null);
  const onlyPhone = opts.onlyPhone || testPhone || null; // testPhone = filtro de 1 lead
  const maxPerRun = opts.maxPerRun != null ? opts.maxPerRun : parseInt(process.env.RECOVERY_MAX_PER_RUN || '8', 10);
  const nowMs = Date.now();
  const report = { _v: 'r4-debug', eligiveis: 0, enviados: 0, pulados: 0, dryRun, onlyPhone, detalhes: [] };
  try {
    // leads quentes: prévia enviada, não pago
    const leads = await supaFetch('GET',
      `orders?preview_sent_at=gte.${RECOVERY_SINCE}&paid_at=is.null&status=eq.preview_sent&phone=not.is.null` +
      `&select=id,phone,honoree_name,relationship,preview_sent_at&order=preview_sent_at.desc&limit=200`);
    if (!Array.isArray(leads)) { return { ...report, erro: 'query falhou' }; }

    for (const o of leads) {
      if (report.enviados >= maxPerRun) { report.detalhes.push({ skip: 'teto atingido' }); break; }
      if (_isJunk(o)) { report.pulados++; continue; }
      if (onlyPhone && _digits(o.phone) !== _digits(onlyPhone)) { report.pulados++; continue; }

      const history = await _recoveryHistory(o.id);
      const attempt = _decide(history, o.preview_sent_at, nowMs);
      if (!attempt) {
        report.pulados++;
        if (onlyPhone) report.detalhes.push({ phone: o.phone, honoree: o.honoree_name, skip: 'sem proxima', history });
        continue;
      }

      if (await _isPaused(o.phone)) {
        report.pulados++;
        report.detalhes.push({ phone: o.phone, honoree: o.honoree_name, skip: 'pausado (humano)' });
        continue;
      }

      report.eligiveis++;
      const text = _msg(attempt);

      if (dryRun) {
        report.detalhes.push({ phone: o.phone, honoree: o.honoree_name, attempt, dryRun: true, preview: text.slice(0, 80) });
        continue;
      }
      try {
        await _sendText(o.phone, text);
        await _logEvent(o.id, o.phone, attempt, text, true);
        report.enviados++;
        report.detalhes.push({ phone: o.phone, honoree: o.honoree_name, attempt, enviado: true });
        await _sleep(2500); // espaça envios (anti-ban)
      } catch (e) {
        await _logEvent(o.id, o.phone, attempt, text, false);
        report.detalhes.push({ phone: o.phone, honoree: o.honoree_name, attempt, erro: e.message });
      }
    }
    console.log(`[Recovery] passada: ${report.enviados} enviados, ${report.pulados} pulados, dryRun=${dryRun}, onlyPhone=${onlyPhone || '-'}`);
    return report;
  } catch (e) {
    console.error('[Recovery] erro:', e.message);
    return { ...report, erro: e.message };
  } finally {
    _running = false;
  }
}

function startRecoveryCron() {
  if (_timer) return;
  if (process.env.RECOVERY_ENABLED !== 'true') {
    console.log('[Recovery] cron OFF (defina RECOVERY_ENABLED=true para ligar)');
    return;
  }
  const min = parseInt(process.env.RECOVERY_INTERVAL_MIN || '60', 10);
  console.log(`[Recovery] ✅ cron ON — a cada ${min}min (testPhone=${process.env.RECOVERY_TEST_PHONE || '-'}, dryRun=${process.env.RECOVERY_DRY_RUN || 'false'})`);
  setTimeout(() => {
    runRecoveryOnce();
    _timer = setInterval(runRecoveryOnce, Math.max(5, min) * 60 * 1000);
  }, 60000);
}

module.exports = { runRecoveryOnce, startRecoveryCron };
