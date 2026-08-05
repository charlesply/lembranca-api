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
  return { Authorization: `Bearer ${await appmaxToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

// 🚨 BLOQUEADOR DESCOBERTO EM SANDBOX (04/ago): os endpoints de RECURSO abaixo
// (/customers, /orders, /payments/pix) retornam 500 "Create customer error" com
// o token de APP (client_credentials do app). A Appmax é um modelo OAuth de app
// INSTALÁVEL (2 camadas, tipo Shopify): resource calls exigem um token de
// MERCHANT, obtido DEPOIS do fluxo de instalação (`POST /app/authorize` → o
// merchant autoriza → a Appmax POSTa client_id/client_secret DE MERCHANT no
// nosso callback de instalação). Ou seja: APPMAX_CLIENT_ID/SECRET aqui precisam
// ser as credenciais de MERCHANT (não as do app) pra estas chamadas funcionarem.
// Campos abaixo JÁ VALIDADOS contra a coleção Postman oficial — só falta a
// camada de auth de merchant (ver header do arquivo + reference/memória).

// ── Cria customer → retorna customerId. Campos validados (Postman oficial):
//    first_name, last_name, email, phone, document_number(CPF), ip — todos req.
async function createAppmaxCustomer({ name, cpfCnpj, email, phone, ip }) {
  const doc = String(cpfCnpj || '').replace(/\D/g, '');
  if (!doc) throw new Error('cpf ausente (Appmax exige)');
  const [firstName, ...rest] = String(name || 'Cliente').trim().split(/\s+/);
  const body = {
    first_name: firstName || 'Cliente',
    last_name: rest.join(' ') || '.',
    email: email || undefined,
    phone: phone ? String(phone).replace(/\D/g, '') : undefined,
    document_number: doc,
    ip: ip || undefined,
  };
  const r = await axios.post(`${APPMAX_API}/customers`, body, { headers: await appmaxHeaders(), timeout: 20000 });
  const id = r.data?.id || r.data?.data?.id || r.data?.data?.customer?.id;
  if (!id) { const err = new Error('appmax_customer_sem_id'); err.response = { data: r.data }; throw err; }
  return id;
}

// ── Cria order → retorna orderId. Campos validados (Postman oficial):
//    customer_id(int), discount_value, shipping_value, products[{sku, name,
//    quantity, unit_value EM CENTAVOS, type:'digital'}].
async function createAppmaxOrder({ customerId, valueCents, description }) {
  const body = {
    customer_id: Number(customerId),
    discount_value: 0,
    shipping_value: 0,
    products: [{
      sku: 'LC-MUSICA',
      name: (description || 'Lembrança Cantada').slice(0, 120),
      quantity: 1,
      unit_value: Math.round(valueCents), // ⚠️ EM CENTAVOS (2990 = R$29,90)
      type: 'digital',
    }],
  };
  const r = await axios.post(`${APPMAX_API}/orders`, body, { headers: await appmaxHeaders(), timeout: 20000 });
  const id = r.data?.id || r.data?.data?.id || r.data?.data?.order?.id;
  if (!id) { const err = new Error('appmax_order_sem_id'); err.response = { data: r.data }; throw err; }
  return id;
}

// ── Cria pagamento PIX → mesma shape de retorno do createAsaasPixCharge ────────
//   { id, brCode, qrImageBase64 (data-URI), value, expiresAt }
// Assim o /api/pay/create e o front NÃO mudam (drop-in do ASAAS).
// Resposta PIX (validado): data.payment.pix_emv + data.payment.pix_qrcode.
async function createAppmaxPixCharge({ orderId, valueCents, description, cpf, customerName, email, phone, ip }) {
  if (!APPMAX_CLIENT_ID) throw new Error('APPMAX credenciais ausentes');
  const doc = String(cpf || '').replace(/\D/g, '');
  if (!doc) { const e = new Error('cpf_obrigatorio'); e.needsCpf = true; throw e; }

  const customerId = await createAppmaxCustomer({ name: customerName, cpfCnpj: doc, email, phone, ip });
  const appmaxOrderId = await createAppmaxOrder({ customerId, valueCents, description });

  // POST /payments/pix — resposta traz pix_emv + pix_qrcode em data.payment.
  // (não há campo pra amarrar nosso orderId no request; o webhook amarra pelo
  //  id da cobrança Appmax = pay_reference, gravado em abacate_charge_id.)
  const pr = await axios.post(`${APPMAX_API}/payments/pix`, {
    order_id: Number(appmaxOrderId),
    payment_data: { pix: { document_number: doc } },
  }, { headers: await appmaxHeaders(), timeout: 20000 });

  const pay = pr.data?.data?.payment || pr.data?.data || pr.data || {};
  const emv = pay.pix_emv;
  if (!emv) { const err = new Error('appmax_sem_pix_emv'); err.response = { data: pr.data }; throw err; }
  const qrPng = pay.pix_qrcode; // PNG base64 SEM prefixo data:
  return {
    id: pay.pay_reference || appmaxOrderId,
    appmaxOrderId,
    brCode: emv,
    qrImageBase64: qrPng ? (String(qrPng).startsWith('data:') ? qrPng : `data:image/png;base64,${qrPng}`) : null,
    value: Math.round(valueCents) / 100,
    expiresAt: pay.pix_expiration_date || null,
  };
}

module.exports = { createAppmaxPixCharge, createAppmaxCustomer, createAppmaxOrder, appmaxToken, APPMAX_CLIENT_ID };
