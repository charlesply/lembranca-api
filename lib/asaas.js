// lib/asaas — integração PIX DIRETA com a ASAAS (o "trilho" real que fica por
// baixo da AbacatePay: todo brCode da Abacate saía por pix.asaas.com). Conta
// LUPELIUS própria, aprovada 13/jul/2026 → cortamos o intermediário.
//
// Docs: https://docs.asaas.com/
//   Auth:   header `access_token: <API_KEY>`  (produção: https://api.asaas.com/v3)
//   Fluxo:  cria cobrança PIX  (POST /payments, billingType=PIX)
//           → pega o QR        (GET  /payments/{id}/pixQrCode)
//           → confirma         (webhook PAYMENT_RECEIVED/CONFIRMED → /api/webhooks/asaas)
//
//   ⚠️ value é em REAIS (decimal), NÃO centavos (2990 centavos → 29.90).
//   ⚠️ A ASAAS exige um "customer" (com CPF/CNPJ) na cobrança. Usamos UM cliente
//      interno FIXO (ASAAS_CUSTOMER_ID, no CNPJ da LUPELIUS) pra todas as
//      cobranças — o pagador real paga pelo banco dele; o customer é só o
//      registro da cobrança, então não precisamos coletar CPF no checkout.
const axios = require('axios');

const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '';
const ASAAS_API = process.env.ASAAS_API || 'https://api.asaas.com/v3';
const ASAAS_CUSTOMER_ID = process.env.ASAAS_CUSTOMER_ID || '';

function asaasHeaders() {
  return {
    access_token: ASAAS_API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': 'LembrancaCantada/1.0',
  };
}

// Data BRT de hoje (YYYY-MM-DD) — dueDate da cobrança. BRT = UTC-3.
function brtToday() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Cria (ou reusa) um cliente ASAAS REAL com o documento do pagador. Usado na
// variante B do checkout A/B (a ASAAS exige um customer com CPF/CNPJ; aqui a
// gente passa o do cliente de verdade em vez do cliente interno fixo).
// Retorna o customerId (cus_...). Reusa se já existir um com o mesmo cpfCnpj.
async function createAsaasCustomer({ name, cpfCnpj, email, phone }) {
  if (!ASAAS_API_KEY) throw new Error('ASAAS_API_KEY ausente');
  const doc = String(cpfCnpj || '').replace(/\D/g, '');
  if (!doc) throw new Error('cpfCnpj ausente');
  // reusa cliente existente com o mesmo documento (evita duplicar)
  try {
    const ex = await axios.get(`${ASAAS_API}/customers?cpfCnpj=${doc}&limit=1`, { headers: asaasHeaders(), timeout: 15000 });
    const found = ex.data && Array.isArray(ex.data.data) && ex.data.data[0];
    if (found && found.id) return found.id;
  } catch (_) { /* segue e cria */ }
  // notificationDisabled: NASCE com a régua de cobrança DESLIGADA → sem taxa de
  // "mensageria" (R$0,99/notif). Raiz do problema: sem isso, cada cliente novo
  // vinha com a régua ON. NÓS entregamos/notificamos, não precisamos da ASAAS.
  const body = { name: (name || 'Cliente').slice(0, 100), cpfCnpj: doc, notificationDisabled: true };
  if (email) body.email = String(email).slice(0, 120);
  if (phone) { const p = String(phone).replace(/\D/g, ''); if (p) body.mobilePhone = p.slice(0, 15); }
  const r = await axios.post(`${ASAAS_API}/customers`, body, { headers: asaasHeaders(), timeout: 20000 });
  if (!r.data || !r.data.id) { const err = new Error('asaas_customer_sem_id'); err.response = { data: r.data }; throw err; }
  return r.data.id;
}

// Cria cobrança PIX e já busca o QR. Retorna
//   { id, brCode, qrImageBase64 (data-URI p/ <img>), value, expiresAt }  ou lança.
// customerId opcional — default = cliente interno fixo (ASAAS_CUSTOMER_ID).
async function createAsaasPixCharge({ orderId, valueCents, description, externalReference, dueDate, customerId }) {
  if (!ASAAS_API_KEY) throw new Error('ASAAS_API_KEY ausente');
  const customer = customerId || ASAAS_CUSTOMER_ID;
  if (!customer) throw new Error('ASAAS customer ausente (customerId/ASAAS_CUSTOMER_ID)');
  const value = Math.round(valueCents) / 100; // ASAAS = reais (decimal)

  // 1) cria a cobrança PIX
  const pr = await axios.post(`${ASAAS_API}/payments`, {
    customer,
    billingType: 'PIX',
    value,
    dueDate: dueDate || brtToday(),
    description: (description || 'Lembrança Cantada').slice(0, 500),
    externalReference: externalReference || orderId, // webhook amarra o pedido por aqui
  }, { headers: asaasHeaders(), timeout: 20000 });
  const pay = pr.data;
  if (!pay || !pay.id) {
    const err = new Error('asaas_sem_id');
    err.response = { data: pr.data };
    throw err;
  }

  // 2) pega o QR PIX (payload = brCode copia-e-cola; encodedImage = PNG base64)
  const qr = await axios.get(`${ASAAS_API}/payments/${pay.id}/pixQrCode`, {
    headers: asaasHeaders(), timeout: 20000,
  });
  const q = qr.data;
  if (!q || !q.payload) {
    const err = new Error('asaas_sem_qr');
    err.response = { data: q };
    throw err;
  }

  return {
    id: pay.id,
    brCode: q.payload,
    qrImageBase64: q.encodedImage ? `data:image/png;base64,${q.encodedImage}` : null,
    value,
    expiresAt: q.expirationDate || pay.dueDate || null,
  };
}

module.exports = { createAsaasPixCharge, createAsaasCustomer, ASAAS_API_KEY, ASAAS_CUSTOMER_ID };
