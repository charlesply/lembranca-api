// LEITOR DE COMPROVANTE — lê PDF (ou imagem) de comprovante de pagamento e extrai os dados
// (valor, data, método, se confirma pagamento). Usa o GPT-4o-mini que lê PDF/imagem nativamente
// (sem dependência de lib de PDF). Resolve o caso do cliente que manda PDF do banco no WhatsApp.
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
const MODEL = process.env.RECEIPT_MODEL || 'gpt-4o-mini';

// pega o base64 da mídia (PDF/imagem) de uma mensagem do WhatsApp via Evolution
async function fetchMediaBase64(phone, msgId) {
  const remoteJid = String(phone).includes('@') ? phone : phone + '@s.whatsapp.net';
  const r = await axios.post(`${EVO_URL}/chat/getBase64FromMediaMessage/${EVO_INSTANCE}`,
    { message: { key: { remoteJid, fromMe: false, id: msgId } } },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 30000 });
  let b64 = r.data && (r.data.base64 || (typeof r.data === 'string' ? r.data : null));
  if (!b64) return null;
  return String(b64).replace(/^data:[^;]+;base64,/, '');
}

const PROMPT = `Analise este comprovante de pagamento brasileiro (PDF ou imagem) e responda SOMENTE um JSON com estes campos:
{
  "e_comprovante": boolean,        // é um comprovante de pagamento/transferência/PIX?
  "confirma_pagamento": boolean,   // parece um pagamento EFETUADO/concluído com sucesso?
  "valor_reais": number|null,      // valor em reais, ex 39.90 (null se não achar)
  "data": string|null,             // data do pagamento (texto), ou null
  "metodo": string|null,           // "PIX" | "TED" | "transferência" | "boleto" | etc
  "beneficiario": string|null,     // para quem foi pago, ou null
  "confianca": number,             // 0 a 1 — sua confiança na leitura
  "resumo": string                 // 1 frase descrevendo o documento
}
Não invente. Se não for comprovante, e_comprovante=false. Responda só o JSON.`;

// Lê o comprovante. Aceita: { base64, mime } OU { url } OU { phone, msgId }.
async function readReceipt({ base64, mime, url, phone, msgId } = {}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurado.');

  let b64 = base64 || null;
  let contentType = mime || 'application/pdf';
  if (!b64 && phone && msgId) {
    b64 = await fetchMediaBase64(phone, msgId);
    if (!b64) return { e_comprovante: false, erro: 'mídia não encontrada no Evolution' };
  }
  if (!b64 && url) {
    const dl = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    b64 = Buffer.from(dl.data).toString('base64');
    contentType = dl.headers['content-type'] || contentType;
  }
  if (!b64) return { e_comprovante: false, erro: 'sem base64/url/msgId' };
  b64 = String(b64).replace(/^data:[^;]+;base64,/, '');

  const isImage = /image\//i.test(contentType);
  const dataUrl = `data:${isImage ? contentType : 'application/pdf'};base64,${b64}`;
  const filePart = isImage
    ? { type: 'image_url', image_url: { url: dataUrl } }
    : { type: 'file', file: { filename: 'comprovante.pdf', file_data: dataUrl } };

  const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, filePart] }],
    temperature: 0,
    max_tokens: 400,
    response_format: { type: 'json_object' },
  }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 45000 });

  const raw = resp.data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = { e_comprovante: false, erro: 'JSON inválido', raw: raw.slice(0, 200) }; }
  return parsed;
}

module.exports = { readReceipt, fetchMediaBase64 };
