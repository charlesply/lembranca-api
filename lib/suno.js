const SunoClient = require('../SunoClient');
const { supaFetch } = require('./supabase');

let client = null;

// Idade maxima do cookie quente antes de cair pro env (minutos). Cron renova a cada 2h.
const WARM_MAX_AGE_MIN = parseInt(process.env.WARM_COOKIE_MAX_AGE_MIN || '360', 10);

/**
 * Decide qual cookie usar:
 *  - USE_WARM_COOKIE=true  -> tenta o cookie quente da tabela suno_session (Keep-Warm).
 *    So usa se: logado, cookie nao-vazio e atualizado ha <= WARM_MAX_AGE_MIN.
 *  - Caso contrario, ou se algo falhar -> cai no env SUNO_COOKIE (comportamento atual).
 * NUNCA lanca: sempre retorna algo (fallback env).
 */
async function getActiveCookie() {
  const envCookie = process.env.SUNO_COOKIE || '';
  if (String(process.env.USE_WARM_COOKIE).toLowerCase() !== 'true') {
    return { cookie: envCookie, source: 'env' };
  }
  try {
    const rows = await supaFetch('GET', 'suno_session?id=eq.1&select=cookie,logged_in,updated_at,cookie_length');
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.logged_in && row.cookie && row.cookie.length > 1000) {
      const ageMin = (Date.now() - new Date(row.updated_at).getTime()) / 60000;
      if (ageMin <= WARM_MAX_AGE_MIN) {
        return { cookie: row.cookie, source: 'warm', age_min: Math.round(ageMin) };
      }
      console.warn(`[ActiveCookie] cookie quente velho (${Math.round(ageMin)}min > ${WARM_MAX_AGE_MIN}min) -> fallback env`);
      return { cookie: envCookie, source: 'env-stale-warm', warm_age_min: Math.round(ageMin) };
    }
    console.warn('[ActiveCookie] sem cookie quente valido (logado/len) -> fallback env');
  } catch (e) {
    console.error('[ActiveCookie] erro lendo warm (fallback env):', e.message);
  }
  return { cookie: envCookie, source: 'env-fallback' };
}

/**
 * Retorna o SunoClient singleton — init() é chamado 1 vez só.
 * O keepAlive (setInterval 30s) mantém o token fresco.
 * Em resetClient() o singleton é descartado e o próximo getClient() relê o
 * cookie ATIVO (quente, se habilitado) — é assim que um 422 se auto-recupera.
 *
 * IMPORTANTE: NÃO crie new SunoClient() em cada request/step.
 */
async function getClient() {
  if (!client) {
    const { cookie, source } = await getActiveCookie();
    if (!cookie) throw new Error('SUNO_COOKIE nao configurado (warm e env vazios).');
    console.log(`[SunoClient] init cookie source=${source} len=${cookie.length}`);
    client = new SunoClient(cookie);
    await client.init();
  }
  return client;
}

function resetClient() { client = null; }

function isAuthError(msg) {
  return msg.includes('session') || msg.includes('401') || msg.includes('cookie') || msg.includes('Atualize');
}

module.exports = { getClient, resetClient, isAuthError, getActiveCookie };
