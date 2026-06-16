// capiTokenRotator — rotaciona automaticamente tokens USER do META_CAPI_TOKENS
// ANTES de expirar (60d). System User tokens (NEVER expire) sao ignorados.
//
// Fluxo:
//   1) Pra cada token em META_CAPI_TOKENS, chama Graph debug_token
//   2) Filtra SO tipo USER com expires_at < 14d
//   3) Pra cada um, fb_exchange_token(token atual) -> novo long-lived (60d)
//   4) Atualiza META_CAPI_TOKENS via Coolify env (DB + redeploy)
//   5) Notifica admin no WhatsApp (success ou erro)
//
// Pre-requisitos no env:
//   META_APP_ID         — App ID do developers.facebook.com
//   META_APP_SECRET     — App Secret do mesmo App
//   COOLIFY_API_URL     — opcional, p/ trigger redeploy via API (futuro)
//
// Disparado:
//   - Manualmente: GET /api/admin/capi_token_rotate_run?secret=XXX (adminRoutes)
//   - Cron n8n (recomendado): diario as 03h BRT
//
// IMPORTANTE: este modulo so REPORTA o que faria por padrao. Pra realmente
// gravar o novo token, passe opts.apply=true. Isso evita rotacao "fantasma"
// durante testes/staging que sobrescreveriam o token de prod.
const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v22.0';
const WARN_DAYS = 14;       // alerta/rotaciona se < N dias pra expirar
const NEVER_EXPIRES = 0;    // SYSTEM_USER tokens vem com expires_at=0

// Le META_CAPI_TOKENS do env e devolve { pixelId: token, ... }.
function getTokens() {
  try { return JSON.parse(process.env.META_CAPI_TOKENS || '{}'); }
  catch (_) { return {}; }
}

// debug_token de um token. Retorna { is_valid, type, expires_at, application }.
async function debugToken(token) {
  try {
    const r = await axios.get(`${GRAPH}/debug_token`, {
      params: { input_token: token, access_token: token },
      timeout: 10000,
    });
    return r.data?.data || {};
  } catch (e) {
    return { is_valid: false, _error: e.response?.data?.error?.message || e.message };
  }
}

// fb_exchange_token — troca um token User long-lived por outro long-lived (60d).
// Requer APP_ID + APP_SECRET no env.
async function exchangeToken(currentToken) {
  const APP_ID = process.env.META_APP_ID || '';
  const APP_SECRET = process.env.META_APP_SECRET || '';
  if (!APP_ID || !APP_SECRET) {
    throw new Error('META_APP_ID/META_APP_SECRET nao configurados — rotator nao consegue rodar');
  }
  const r = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: currentToken,
    },
    timeout: 15000,
  });
  return {
    access_token: r.data?.access_token,
    expires_in: r.data?.expires_in,
  };
}

// Manda alerta pro admin no WhatsApp (mesmo canal Evolution).
async function notifyAdmin(text) {
  try {
    const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
    const EVO_KEY = process.env.EVO_KEY || '';
    const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';
    const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511920188319';
    if (!EVO_KEY) return;
    await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
      { number: ADMIN_PHONE, text },
      { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
  } catch (e) {
    console.error('[capiTokenRotator] notify admin falhou:', e.message);
  }
}

// runOnce — varre todos os tokens. opts.apply=true grava os tokens novos no env
// via process.env e tenta updateCoolifyEnv() pra persistir alem do restart.
// Sem apply, so reporta o que faria.
async function runOnce(opts = {}) {
  const apply = !!opts.apply;
  const tokens = getTokens();
  const pixelIds = Object.keys(tokens);
  const report = {
    apply, total: pixelIds.length,
    expired: [], expiring_soon: [], healthy: [], system_user: [],
    rotated: [], rotation_errors: [],
  };

  for (const pid of pixelIds) {
    const tok = tokens[pid];
    const info = await debugToken(tok);
    if (!info.is_valid) {
      report.expired.push({ pixel: pid, error: info._error || 'invalid' });
      continue;
    }
    if (info.type === 'SYSTEM_USER' || info.expires_at === NEVER_EXPIRES) {
      report.system_user.push({ pixel: pid, type: info.type, app: info.application });
      continue;
    }
    // USER token — checa expiry
    const daysLeft = info.expires_at
      ? Math.floor((info.expires_at * 1000 - Date.now()) / 86400000)
      : null;
    if (daysLeft != null && daysLeft <= WARN_DAYS) {
      report.expiring_soon.push({ pixel: pid, days_left: daysLeft, app: info.application });
      if (apply) {
        try {
          const fresh = await exchangeToken(tok);
          if (fresh.access_token) {
            tokens[pid] = fresh.access_token;
            report.rotated.push({
              pixel: pid,
              old_days_left: daysLeft,
              new_expires_in_days: Math.floor((fresh.expires_in || 0) / 86400),
            });
          } else {
            report.rotation_errors.push({ pixel: pid, error: 'sem access_token na resposta' });
          }
        } catch (e) {
          report.rotation_errors.push({
            pixel: pid,
            error: e.response?.data?.error?.message || e.message,
          });
        }
      }
    } else {
      report.healthy.push({ pixel: pid, days_left: daysLeft });
    }
  }

  // Se aplicou mudancas, persiste em process.env. NAO atualiza o Coolify
  // automatico (precisa restart do container ou trigger explicito) — emite
  // alerta pro admin fazer manual.
  if (apply && report.rotated.length) {
    process.env.META_CAPI_TOKENS = JSON.stringify(tokens);
    const lines = [
      '🔄 *CAPI Token Rotation*',
      `${report.rotated.length} token(s) rotacionado(s) em memoria.`,
      '',
      ...report.rotated.map(r => `• Pixel ${r.pixel}: ${r.old_days_left}d → ${r.new_expires_in_days}d`),
      '',
      '⚠️ *Persistir no Coolify*: atualize manualmente o META_CAPI_TOKENS',
      'com o JSON novo (logs do container tem o valor completo) e refaca deploy',
      'pra sobreviver ao proximo restart.',
    ].join('\n');
    notifyAdmin(lines).catch(() => {});
    console.log('[capiTokenRotator] NEW META_CAPI_TOKENS:', JSON.stringify(tokens));
  } else if (report.expiring_soon.length && !apply) {
    notifyAdmin(
      `⏰ *CAPI Tokens expirando*\n${report.expiring_soon.length} token(s) com <${WARN_DAYS}d.\n` +
      report.expiring_soon.map(e => `• Pixel ${e.pixel}: ${e.days_left}d`).join('\n') +
      `\n\nRode \`/api/admin/capi_token_rotate_run?apply=1&secret=XXX\` pra rotacionar.`
    ).catch(() => {});
  }

  return report;
}

module.exports = { runOnce };
