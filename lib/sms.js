// lib/sms — envio de SMS via TeleSegNet (apisms.telesegnet.com.br).
//
// Doc: "Integração WebService e HTTP v2.7.5" (envioLote / RESULTADO IMEDIATO).
//   Endpoint: POST http://apisms.telesegnet.com.br/envioLote  (lote até 1500 msgs)
//   Auth:     header account(login) + code(senha) + IP do servidor cadastrado na plataforma
//   Body:     { mensagens: [ { to, tipoEnvio:"2"(SMS), msg, id, form?, linkUrl? } ] }
//   Link:     tag <LINK> no msg + URL real em linkUrl → a plataforma ENCURTA pra
//             20 chars (domínio deles, já aprovado). ⚠️ precisa de ESPAÇO antes do
//             <LINK> pro celular virar hyperlink. Link vale 15 dias.
//   Retorno:  {"status":"OK","descricao":"LOTE RECEBIDO COM SUCESSO"} | {"status":"ERRO",...}
//
// 🔒 GATE: só envia se SMS_ENABLED='true' E SMS_ACCOUNT/SMS_CODE setados. Enquanto
// não tiver a chave, tudo é no-op (não quebra nada, não custa nada).
// ⚠️ SMS custa por envio + é API externa → NÃO plugar em cron de massa sem o ok
// explícito do Charles (regra PLANO B). Por ora: lib + endpoint de teste só.
const axios = require('axios');

const SMS_ENDPOINT = process.env.SMS_ENDPOINT || 'http://apisms.telesegnet.com.br/envioLote';
const SMS_ACCOUNT = process.env.SMS_ACCOUNT || '';
const SMS_CODE = process.env.SMS_CODE || '';
const SMS_ENABLED = process.env.SMS_ENABLED === 'true';
const SITE = (process.env.FRONTEND_URL || 'https://app.lembrancacantada.com').replace(/\/+$/, '');
const NAME_MAX = 20; // corte do 1º nome (cobre "Wellington" e maiores)

// Remove acentos/diacríticos (SMS: acento força UCS-2 e derruba o limite pra 70).
function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// 1º nome, sem acento, só letras, capitalizado, cortado em NAME_MAX. '' se vazio.
function firstNameSafe(fullName, max = NAME_MAX) {
  const first = stripAccents(fullName).trim().split(/\s+/)[0] || '';
  const clean = first.replace(/[^A-Za-z]/g, '');
  if (!clean) return '';
  const capped = clean.slice(0, max);
  return capped.charAt(0).toUpperCase() + capped.slice(1).toLowerCase();
}

// Telefone → 55 + DDD + número (12-13 dígitos). Retorna '' se claramente inválido.
function formatPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10) return '';
  if (!d.startsWith('55')) d = '55' + d;
  return d.slice(0, 13);
}

// Envio em lote (baixo nível). mensagens = [{to,tipoEnvio,msg,id,form?,linkUrl?}].
// Retorna { ok, status, descricao } | { skipped }.
async function sendSmsBatch(mensagens) {
  if (!SMS_ENABLED) return { skipped: 'disabled' };
  if (!SMS_ACCOUNT || !SMS_CODE) return { skipped: 'no_creds' };
  if (!Array.isArray(mensagens) || !mensagens.length) return { skipped: 'empty' };
  try {
    const r = await axios.post(SMS_ENDPOINT, { mensagens }, {
      headers: { 'Content-Type': 'application/json', account: SMS_ACCOUNT, code: SMS_CODE },
      timeout: 20000,
    });
    const status = r.data?.status;
    const ok = String(status).toUpperCase() === 'OK';
    if (ok) console.log('[sms] ✅', mensagens.length, 'msg(s) —', r.data?.descricao);
    else console.warn('[sms] ⚠️ resposta:', JSON.stringify(r.data));
    return { ok, status, descricao: r.data?.descricao, response: r.data };
  } catch (e) {
    console.error('[sms] ❌ erro:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
    return { ok: false, error: String(e.message) };
  }
}

// Monta 1 mensagem com nome + <LINK>. text NÃO deve ter acento e deve terminar
// com espaço antes do <LINK> (a função garante o espaço).
function buildMsg({ name, textNoLink, linkUrl }) {
  const nm = firstNameSafe(name);
  const greet = nm ? `Ola ${nm}! ` : 'Ola! ';
  // garante espaço antes do <LINK> (exigência da doc pro hyperlink funcionar)
  const body = `${greet}${stripAccents(textNoLink)}`.replace(/\s*$/, ' ');
  return { msg: `${body}<LINK>`, form: nm || undefined, linkUrl };
}

// Base do link RASTREÁVEL (/s/{id} no backend → marca clique → redireciona).
// O <LINK> da TeleSegNet encurta ISSO; assim rastreamos clique por pessoa.
const SMS_LINK_BASE = (process.env.SMS_LINK_BASE || 'https://suno-api-novo.bvph.uk').replace(/\/+$/, '');

// ── Monta o objeto de mensagem (sem enviar) — pro batch montar o lote. ────────
// Retorna null se telefone/id inválidos. id único inclui um sufixo de tempo pra
// nunca duplicar (id duplicado = BLOQUEADA na plataforma).
function buildRecoveryMsg(order, idSuffix = '') {
  const to = formatPhone(order?.phone);
  if (!to || !order?.id) return null;
  const { msg, form, linkUrl } = buildMsg({
    name: order.customer_name,
    textNoLink: 'sua musica ficou pronta. Ouca a previa e libere a completa:',
    linkUrl: `${SMS_LINK_BASE}/s/${order.id}`,
  });
  return { to, tipoEnvio: '2', msg, id: `r${idSuffix}-${order.id}`.slice(0, 50), form, linkUrl };
}
function buildDeliveryMsg(order, idSuffix = '') {
  const to = formatPhone(order?.phone);
  if (!to || !order?.id) return null;
  const { msg, form, linkUrl } = buildMsg({
    name: order.customer_name,
    textNoLink: 'sua musica esta pronta para acessar:',
    linkUrl: `${SMS_LINK_BASE}/s/${order.id}`,
  });
  return { to, tipoEnvio: '2', msg, id: `e${idSuffix}-${order.id}`.slice(0, 50), form, linkUrl };
}

// ── Alto nível (1 pedido) — usado no teste. ──────────────────────────────────
async function sendRecoverySms(order) {
  const m = buildRecoveryMsg(order, Date.now().toString(36));
  if (!m) return { skipped: 'sem_to_ou_id' };
  return sendSmsBatch([m]);
}
async function sendDeliverySms(order) {
  const m = buildDeliveryMsg(order, Date.now().toString(36));
  if (!m) return { skipped: 'sem_to_ou_id' };
  return sendSmsBatch([m]);
}

// ── ENTREGA INSTANTÂNEA (chamado do webhook de pagamento, igual o e-mail) ─────
// Self-contained: busca o pedido, checa elegibilidade (fone + música + não-enviado),
// envia e marca sms_sent_at+sms_type. Fire-and-forget (não bloqueia o webhook).
async function deliverSmsOnPaid(orderId) {
  if (!SMS_ENABLED) return { skipped: 'disabled' };
  if (!orderId) return { skipped: 'no_id' };
  const { supaFetch } = require('./supabase');
  const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,customer_name,phone,original_audio_url,sms_sent_at`);
  const o = Array.isArray(rows) && rows[0];
  if (!o || !o.phone || !o.original_audio_url || o.sms_sent_at) return { skipped: 'inelegivel' };
  const m = buildDeliveryMsg(o, Date.now().toString(36));
  if (!m) return { skipped: 'sem_to' };
  const r = await sendSmsBatch([m]);
  if (r.ok) {
    await supaFetch('PATCH', `orders?id=eq.${orderId}`, { sms_sent_at: new Date().toISOString(), sms_type: 'delivery' }).catch(() => {});
    console.log('[sms] ✅ entrega instantânea order', orderId);
  }
  return r;
}

module.exports = { sendSmsBatch, sendRecoverySms, sendDeliverySms, deliverSmsOnPaid, buildRecoveryMsg, buildDeliveryMsg, firstNameSafe, formatPhone, stripAccents, buildMsg, SMS_ENABLED };
