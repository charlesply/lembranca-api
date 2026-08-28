// lib/sms — envio de SMS via ComprarSMS (comprarsms.com) — provedor DIRETO, sem
// intermediador (migrado da TeleSegNet em 08/2026).
//
// Doc: https://comprarsms.com/api
//   Base:  https://xlwblpjbcovfxlcbeiqs.supabase.co/functions/v1  (Supabase Functions)
//   Auth:  POST /api-authenticate {email,password} -> { access_token, expires_in } (JWT ~1h)
//   Envio: POST /api-sms-send  (Bearer <token>)
//            { recipients: [ { phone:"+5511...", message } ] }   (personalizado)
//          ou { phone_numbers:["+5511..."], message }            (mesma msg)
//   Telefone: formato internacional +55DDDNUMERO.
//   ⚠️ A mensagem PRECISA bater com um TEMPLATE aprovado na conta (senão 403
//      TEMPLATE_NOT_APPROVED). Variáveis/links podem variar; a parte fixa não.
//   Resposta OK: { batch_id, success_count, cost, remaining_balance, status:"completed" }
//
// 🔗 ENCURTADOR PRÓPRIO: o ComprarSMS NÃO encurta link. Usamos domínio curto
//   lcantada.com → /s/{code} (code de 7 chars em orders.sms_short_code) que
//   redireciona pro destino real e marca o clique (mesma rota /s de antes).
//
// 🔒 GATE: só envia se SMS_ENABLED='true' E SMS_ACCOUNT(email)/SMS_CODE(senha).
//   Sem isso = no-op (não custa, não quebra).
// ⚠️ SMS custa por envio + é API externa → NÃO plugar em cron de massa sem o ok
//   explícito do Charles (regra PLANO B).
const axios = require('axios');
const { supaFetch } = require('./supabase');

const SMS_BASE = (process.env.SMS_BASE || 'https://xlwblpjbcovfxlcbeiqs.supabase.co/functions/v1').replace(/\/+$/, '');
const SMS_ACCOUNT = process.env.SMS_ACCOUNT || ''; // e-mail de login
const SMS_CODE = process.env.SMS_CODE || '';       // senha
const SMS_ENABLED = process.env.SMS_ENABLED === 'true';
// Base do link CURTO (domínio próprio) → /s/{code} no backend redireciona + marca clique.
const SHORT_BASE = (process.env.SMS_SHORT_BASE || 'https://lcantada.com').replace(/\/+$/, '');
const NAME_MAX = 20;

// Templates (parametrizáveis por env pra casar EXATAMENTE o texto aprovado na
// plataforma). Placeholders: {nome} e {link}. Defaults = os enviados p/ aprovação.
const TPL_RECOVERY = process.env.SMS_TPL_RECOVERY
  || 'Ola {nome}! Sua musica personalizada esta quase pronta. Finalize aqui: {link}';
const TPL_DELIVERY = process.env.SMS_TPL_DELIVERY
  || 'Ola {nome}! Sua musica da Lembranca Cantada esta pronta. Ouca aqui: {link}';

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
// Telefone → +55 + DDD + número. Retorna '' se claramente inválido.
function formatPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10) return '';
  if (!d.startsWith('55')) d = '55' + d;
  return '+' + d.slice(0, 13);
}

// ── AUTH com cache (JWT ~1h) ─────────────────────────────────────────────────
let _token = null, _tokenExp = 0;
async function getToken() {
  const now = Date.now();
  if (_token && now < _tokenExp - 60000) return _token; // renova 1min antes de expirar
  const r = await axios.post(`${SMS_BASE}/api-authenticate`,
    { email: SMS_ACCOUNT, password: SMS_CODE },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
  const t = r.data?.access_token || r.data?.token;
  if (!t) { const e = new Error('sms_auth_fail'); e.response = { data: r.data }; throw e; }
  _token = t;
  _tokenExp = now + (Number(r.data?.expires_in || 3600) * 1000);
  return t;
}

// ── SHORT CODE (encurtador próprio) ──────────────────────────────────────────
// Código curto "seguro pra ler": intercala dígito a cada 2 letras (padrão LLDLLDL)
// → NUNCA forma palavra (evita gerar algo ofensivo no link). Sem chars ambíguos
// (i, l, o / 0, 1) pra facilitar leitura. Padrão de 7 chars: LL D LL D L.
const SC_LET = 'abcdefghjkmnpqrstuvwxyz'; // sem i, l, o
const SC_DIG = '23456789';                // sem 0, 1
function genCode() {
  const L = () => SC_LET[Math.floor(Math.random() * SC_LET.length)];
  const D = () => SC_DIG[Math.floor(Math.random() * SC_DIG.length)];
  return L() + L() + D() + L() + L() + D() + L();
}
// Garante um sms_short_code no pedido (idempotente). Retorna o code (ou null).
async function ensureShortCode(orderId) {
  if (!orderId) return null;
  try {
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=sms_short_code`);
    const cur = Array.isArray(rows) && rows[0] && rows[0].sms_short_code;
    if (cur) return cur;
    const code = genCode();
    await supaFetch('PATCH', `orders?id=eq.${orderId}`, { sms_short_code: code });
    return code;
  } catch (e) { console.warn('[sms] ensureShortCode falhou:', e.message); return null; }
}

// Monta a mensagem a partir do template, substituindo {nome} e {link}. <=160, sem acento.
function buildMessage(tpl, name, link) {
  const nm = firstNameSafe(name) || 'tudo bem';
  return stripAccents(tpl).replace(/\{nome\}/g, nm).replace(/\{link\}/g, link).slice(0, 160);
}

// ── ENVIO (baixo nível) — aceita [{phone,message}] (novo) ou [{to,msg}] (compat). ──
// Retorna { ok, response } | { skipped }.
async function sendSmsBatch(items) {
  if (!SMS_ENABLED) return { skipped: 'disabled' };
  if (!SMS_ACCOUNT || !SMS_CODE) return { skipped: 'no_creds' };
  if (!Array.isArray(items) || !items.length) return { skipped: 'empty' };
  const recipients = items.map((m) => ({
    phone: m.phone || (m.to && (String(m.to).startsWith('+') ? m.to : formatPhone(m.to))) || '',
    message: (m.message || m.msg || '').slice(0, 160),
  })).filter((m) => m.phone && m.message);
  if (!recipients.length) return { skipped: 'empty_after_norm' };
  try {
    const token = await getToken();
    const r = await axios.post(`${SMS_BASE}/api-sms-send`, { recipients }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    const d = r.data || {};
    const ok = d.status === 'completed' || Number(d.success_count || 0) > 0;
    if (ok) console.log(`[sms] ✅ ${recipients.length} msg(s) — batch=${d.batch_id} custo=${d.cost} saldo=${d.remaining_balance}`);
    else console.warn('[sms] ⚠️ resposta:', JSON.stringify(d).slice(0, 300));
    return { ok, response: d };
  } catch (e) {
    const data = e.response?.data;
    console.error('[sms] ❌ erro:', data ? JSON.stringify(data).slice(0, 300) : e.message);
    return { ok: false, error: data?.code || data?.error || String(e.message), response: data };
  }
}

// ── Monta 1 mensagem (com short link) — async por causa do short_code. ───────
async function buildRecoveryMsg(order) {
  const to = formatPhone(order?.phone);
  if (!to || !order?.id) return null;
  const code = await ensureShortCode(order.id);
  if (!code) return null;
  const message = buildMessage(TPL_RECOVERY, order.customer_name, `${SHORT_BASE}/s/${code}`);
  return { phone: to, message };
}
async function buildDeliveryMsg(order) {
  const to = formatPhone(order?.phone);
  if (!to || !order?.id) return null;
  const code = await ensureShortCode(order.id);
  if (!code) return null;
  const message = buildMessage(TPL_DELIVERY, order.customer_name, `${SHORT_BASE}/s/${code}`);
  return { phone: to, message };
}

// ── Alto nível (1 pedido) ────────────────────────────────────────────────────
async function sendRecoverySms(order) {
  const m = await buildRecoveryMsg(order);
  if (!m) return { skipped: 'sem_to_ou_id' };
  return sendSmsBatch([m]);
}
async function sendDeliverySms(order) {
  const m = await buildDeliveryMsg(order);
  if (!m) return { skipped: 'sem_to_ou_id' };
  return sendSmsBatch([m]);
}

// ── ENTREGA INSTANTÂNEA (chamado do webhook de pagamento, igual o e-mail) ─────
async function deliverSmsOnPaid(orderId) {
  if (!SMS_ENABLED) return { skipped: 'disabled' };
  if (!orderId) return { skipped: 'no_id' };
  const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,customer_name,phone,original_audio_url,sms_sent_at`);
  const o = Array.isArray(rows) && rows[0];
  if (!o || !o.phone || !o.original_audio_url || o.sms_sent_at) return { skipped: 'inelegivel' };
  const m = await buildDeliveryMsg(o);
  if (!m) return { skipped: 'sem_to' };
  const r = await sendSmsBatch([m]);
  if (r.ok) {
    await supaFetch('PATCH', `orders?id=eq.${orderId}`, { sms_sent_at: new Date().toISOString(), sms_type: 'delivery' }).catch(() => {});
    console.log('[sms] ✅ entrega instantânea order', orderId);
  }
  return r;
}

module.exports = {
  sendSmsBatch, sendRecoverySms, sendDeliverySms, deliverSmsOnPaid,
  buildRecoveryMsg, buildDeliveryMsg, ensureShortCode, buildMessage,
  firstNameSafe, formatPhone, stripAccents, getToken, SMS_ENABLED,
};
