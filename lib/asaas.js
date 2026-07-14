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

// Cria cobrança PIX e já busca o QR. Retorna
//   { id, brCode, qrImageBase64 (data-URI p/ <img>), value, expiresAt }  ou lança.
async function createAsaasPixCharge({ orderId, valueCents, description, externalReference, dueDate }) {
  if (!ASAAS_API_KEY) throw new Error('ASAAS_API_KEY ausente');
  if (!ASAAS_CUSTOMER_ID) throw new Error('ASAAS_CUSTOMER_ID ausente');
  const value = Math.round(valueCents) / 100; // ASAAS = reais (decimal)

  // 1) cria a cobrança PIX
  const pr = await axios.post(`${ASAAS_API}/payments`, {
    customer: ASAAS_CUSTOMER_ID,
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

module.exports = { createAsaasPixCharge, ASAAS_API_KEY, ASAAS_CUSTOMER_ID };
