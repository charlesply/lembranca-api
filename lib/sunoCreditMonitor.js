// MONITOR DE CRÉDITOS DA SUNOAPI — checa o saldo a cada N minutos e dispara
// alerta no WhatsApp pessoal do dono se cair abaixo do limiar.
//
// Por quê: já tivemos incidente onde os créditos zeraram e ~5 pedidos pagos
// quebraram. Esse cron fecha o buraco antes do operacional sentir.
//
// Estratégia anti-flood (hysteresis):
//   - dispara alerta UMA vez quando saldo cruza pra baixo de THRESHOLD
//   - só re-arma o alarme quando saldo volta pra cima de RECOVERY (THRESHOLD*1.5)
//   - estado fica em memória do processo (reseta no restart, e tudo bem —
//     se o saldo continuar baixo após restart, vai alertar de novo na 1ª rodada)
//
// Gated por SUNO_CREDIT_MONITOR_ENABLED=false pra desligar.
const axios = require('axios');
const { getCredits } = require('./sunoApi');

const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';

// telefone PESSOAL do dono pra alerta crítico (não é cliente, é operacional)
const OWNER_PHONE = process.env.SUNO_CREDIT_ALERT_PHONE || '5511992667376';

const THRESHOLD = Math.max(0, parseInt(process.env.SUNO_CREDIT_THRESHOLD || '1000', 10));
const RECOVERY = Math.max(THRESHOLD + 100, parseInt(process.env.SUNO_CREDIT_RECOVERY || String(Math.round(THRESHOLD * 1.5)), 10));
const INTERVAL_MIN = Math.max(5, parseInt(process.env.SUNO_CREDIT_INTERVAL_MIN || '30', 10));
const FIRST_RUN_DELAY_MS = 60 * 1000; // espera o app subir antes da 1ª checagem

let _timer = null;
let _lastState = 'unknown'; // 'unknown' | 'ok' | 'low'

async function _sendText(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
    { number: String(phone).replace(/\D/g, ''), text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
}

// Faz uma checagem e age conforme o estado anterior.
// Retorna {credits, state, alerted, recovered}.
async function runOnce({ force = false } = {}) {
  let credits = null;
  try {
    credits = await getCredits();
  } catch (e) {
    console.error('[sunoCreditMonitor] erro ao consultar saldo:', e.message);
    return { ok: false, error: e.message };
  }
  if (typeof credits !== 'number') {
    console.warn('[sunoCreditMonitor] saldo não retornou número:', credits);
    return { ok: false, credits, note: 'saldo nao numerico' };
  }

  const prev = _lastState;
  let newState = prev;
  let alerted = false;
  let recovered = false;

  if (credits < THRESHOLD) {
    newState = 'low';
    // alerta se mudou de estado OU se é a primeira rodada com saldo baixo OU se foi forçado
    if (prev !== 'low' || force) {
      const msg =
        `🚨 *SunoAPI BAIXA*\n\n` +
        `Saldo atual: *${credits} créditos*\n` +
        `Limiar: ${THRESHOLD}\n\n` +
        `Recarrega antes que zere e quebre pedidos pagos:\n` +
        `https://sunoapi.org`;
      try { await _sendText(OWNER_PHONE, msg); alerted = true; }
      catch (e) { console.error('[sunoCreditMonitor] envio alerta falhou:', e.message); }
    }
  } else if (credits >= RECOVERY) {
    newState = 'ok';
    // notifica recuperação só se estava em 'low'
    if (prev === 'low') {
      const msg =
        `✅ *SunoAPI recuperada*\n\n` +
        `Saldo atual: *${credits} créditos*\n` +
        `(voltou acima de ${RECOVERY})`;
      try { await _sendText(OWNER_PHONE, msg); recovered = true; }
      catch (e) { console.error('[sunoCreditMonitor] envio recovery falhou:', e.message); }
    }
  } else {
    // zona neutra (entre THRESHOLD e RECOVERY): mantém estado anterior
    // — evita alertar em loop quando saldo oscila perto do limiar
    newState = prev === 'unknown' ? 'ok' : prev;
  }

  _lastState = newState;
  console.log(`[sunoCreditMonitor] saldo=${credits} state=${prev}→${newState} alerted=${alerted} recovered=${recovered}`);
  return { ok: true, credits, state: newState, prev_state: prev, alerted, recovered, threshold: THRESHOLD, recovery: RECOVERY };
}

function startCron() {
  if (process.env.SUNO_CREDIT_MONITOR_ENABLED === 'false') {
    console.log('[sunoCreditMonitor] desabilitado (SUNO_CREDIT_MONITOR_ENABLED=false)');
    return;
  }
  if (_timer) return;
  console.log(`[sunoCreditMonitor] ✅ cron ON — checa saldo a cada ${INTERVAL_MIN}min (alerta < ${THRESHOLD}, recovery >= ${RECOVERY}, phone=${OWNER_PHONE})`);
  setTimeout(() => {
    runOnce().catch(e => console.error('[sunoCreditMonitor]', e.message));
    _timer = setInterval(() => {
      runOnce().catch(e => console.error('[sunoCreditMonitor]', e.message));
    }, INTERVAL_MIN * 60 * 1000);
  }, FIRST_RUN_DELAY_MS);
}

module.exports = { runOnce, startCron, THRESHOLD, RECOVERY, INTERVAL_MIN };
