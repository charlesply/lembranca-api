// lib/appmax — integração PIX INLINE com a Appmax (alternativa ao ASAAS).
//
// ⚠️⚠️ SCAFFOLD / NÃO ATIVO EM PRODUÇÃO ⚠️⚠️
// Escrito ANTES das credenciais saírem (04/ago/2026). Fica travado atrás de
// PIX_PROVIDER=appmax (que continua 'asaas'). NÃO deployar/ativar até:
//   1. ter as credenciais (sandbox primeiro) e
//   2. CONFIRMAR contra a doc os pontos marcados com «TODO CONFIRMAR».
//
// Docs: https://docs.appmax.com.br/  ·  https://appmax.readme.io/reference/guia
//   Base:   prod    https://api.appmax.com.br/v1
//           sandbox https://api.sandboxappmax.com.br/v1   (recomendado p/ testar)
//   Auth:   OAuth2 client_credentials (CONFIRMADO 04/ago) — em HOST SEPARADO do API:
//           prod    https://auth.appmax.com.br/oauth2/token
//           sandbox https://auth.sandboxappmax.com.br/oauth2/token
//           body = form-urlencoded (NÃO json); resposta {access_token, expires_in:3600};
//           token Bearer dura 1h, SEM refresh.
//   Credenciais: geradas ao criar um APP no AppStore (appstore.appmax.com.br) e
//           enviadas por E-MAIL após validação do CNPJ (client_id + client_secret
//           + app_id uuid + app_id numérico). NÃO ficam no painel — chegam no email.
//   Fluxo:  auth → cria customer → cria order → cria pagamento PIX
//   PIX:    POST /payments/pix {order_id, payment_data:{pix:{document_number}}}
//           → resp: pix_emv (copia-e-cola/brCode) + pix_qrcode (PNG base64) +
//             pix_expiration_date + pay_reference   ← CONFIRMADO na doc (inline!)
//   Webhook: eventos order_pix_created / order_paid_by_pix (SEM assinatura HMAC —
//            validar por IP/schema). ← CONFIRMADO na doc.
//
// ⚠️ CPF obrigatório no PIX Appmax (payment_data.pix.document_number). Já
//    coletamos CPF no checkout ASAAS — reaproveitar.
const axios = require('axios');

const APPMAX_API = process.env.APPMAX_API || 'https://api.appmax.com.br/v1';
// Auth em HOST SEPARADO do API (confirmado 04/ago). Sandbox: trocar por
// https://auth.sandboxappmax.com.br/oauth2/token via env.
const APPMAX_AUTH_URL = process.env.APPMAX_AUTH_URL || 'https://auth.appmax.com.br/oauth2/token';
const APPMAX_CLIENT_ID = process.env.APPMAX_CLIENT_ID || '';
const APPMAX_CLIENT_SECRET = process.env.APPMAX_CLIENT_SECRET || '';

// ── Auth: OAuth2 client_credentials (CONFIRMADO). Body = form-urlencoded (NÃO
//    json). Token Bearer dura 1h, sem refresh. Cacheia até ~1min antes de expirar.
let _token = null;
let _tokenExp = 0;
async function appmaxToken() {
  if (!APPMAX_CLIENT_ID || !APPMAX_CLIENT_SECRET) throw new Error('APPMAX_CLIENT_ID/SECRET ausentes');
  const now = Date.now();
  if (_token && now < _tokenExp - 60000) return _token;
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: APPMAX_CLIENT_ID,
    client_secret: APPMAX_CLIENT_SECRET,
  });
  const r = await axios.post(APPMAX_AUTH_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000,
  });
  const d = r.data || {};
  const tok = d.access_token || d.token;
  if (!tok) { const err = new Error('appmax_sem_token'); err.response = { data: d }; throw err; }
  _token = tok;
  const ttl = Number(d.expires_in) > 0 ? Number(d.expires_in) * 1000 : 3600 * 1000;
  _tokenExp = now + ttl;
  return _token;
}
async function appmaxHeaders() {
  return { Authorization: `Bearer ${await appmaxToken()}`, 'Content-Type': 'application/json' };
}

// ── Cria customer (Appmax exige CPF) → retorna customerId ─────────────────────
// «TODO CONFIRMAR» — path e campos exatos (/customers) contra a doc.
async function createAppmaxCustomer({ name, cpfCnpj, email, phone }) {
  const doc = String(cpfCnpj || '').replace(/\D/g, '');
  if (!doc) throw new Error('cpf ausente (Appmax exige)');
  const [firstname, ...rest] = String(name || 'Cliente').trim().split(/\s+/);
  const body = {
    firstname: firstname || 'Cliente',
    lastname: rest.join(' ') || '.',
    email: email || undefined,
    telephone: phone ? String(phone).replace(/\D/g, '') : undefined,
    document_number: doc,
  };
  const r = await axios.post(`${APPMAX_API}/customers`, body, { headers: await appmaxHeaders(), timeout: 20000 });
  const id = r.data?.id || r.data?.data?.id;
  if (!id) { const err = new Error('appmax_customer_sem_id'); err.response = { data: r.data }; throw err; }
  return id;
}

// ── Cria order → retorna orderId (Appmax) ─────────────────────────────────────
// «TODO CONFIRMAR» — path /orders e formato de products/total contra a doc.
async function createAppmaxOrder({ customerId, valueCents, description }) {
  const total = Math.round(valueCents) / 100; // reais decimal (confirmar unidade)
  const body = {
    customer_id: customerId,
    total,
    products: [{ name: (description || 'Lembrança Cantada').slice(0, 120), qty: 1, price: total, digital_product: 1 }],
  };
  const r = await axios.post(`${APPMAX_API}/orders`, body, { headers: await appmaxHeaders(), timeout: 20000 });
  const id = r.data?.id || r.data?.data?.id;
  if (!id) { const err = new Error('appmax_order_sem_id'); err.response = { data: r.data }; throw err; }
  return id;
}

// ── Cria pagamento PIX → mesma shape de retorno do createAsaasPixCharge ────────
//   { id, brCode, qrImageBase64 (data-URI), value, expiresAt }
// Assim o /api/pay/create e o front NÃO mudam (drop-in do ASAAS).
async function createAppmaxPixCharge({ orderId, valueCents, description, cpf, customerName, email, phone }) {
  if (!APPMAX_CLIENT_ID) throw new Error('APPMAX credenciais ausentes');
  const doc = String(cpf || '').replace(/\D/g, '');
  if (!doc) { const e = new Error('cpf_obrigatorio'); e.needsCpf = true; throw e; }

  const customerId = await createAppmaxCustomer({ name: customerName, cpfCnpj: doc, email, phone });
  const appmaxOrderId = await createAppmaxOrder({ customerId, valueCents, description });

  // POST /payments/pix — CONFIRMADO: resposta traz pix_emv + pix_qrcode inline.
  const pr = await axios.post(`${APPMAX_API}/payments/pix`, {
    order_id: appmaxOrderId,
    payment_data: { pix: { document_number: doc } },
    // client_key/external_key: pra o webhook amarrar de volta ao NOSSO orderId.
    // «TODO CONFIRMAR» o nome do campo que volta no webhook (client_key/external_key).
    client_key: orderId,
  }, { headers: await appmaxHeaders(), timeout: 20000 });

  const d = pr.data?.data || pr.data || {};
  const emv = d.pix_emv || d.pix_qrcode_text || d.qrcode;
  if (!emv) { const err = new Error('appmax_sem_pix_emv'); err.response = { data: pr.data }; throw err; }
  const qrPng = d.pix_qrcode || d.qrcode_image; // PNG base64 SEM prefixo data:
  return {
    id: d.pay_reference || appmaxOrderId,
    appmaxOrderId,
    brCode: emv,
    qrImageBase64: qrPng ? (String(qrPng).startsWith('data:') ? qrPng : `data:image/png;base64,${qrPng}`) : null,
    value: Math.round(valueCents) / 100,
    expiresAt: d.pix_expiration_date || null,
  };
}

module.exports = { createAppmaxPixCharge, createAppmaxCustomer, createAppmaxOrder, appmaxToken, APPMAX_CLIENT_ID };
