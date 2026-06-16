// promoNamorados — logica da campanha de recovery Dia dos Namorados 2026.
//
// Audiencia (filtro AND, todos obrigatorios):
//   1. orders.status = 'preview_sent'
//   2. orders.paid_at IS NULL
//   3. orders.relationship em (Esposo, Esposa, Namorado, Namorada, Marido,
//      Mulher, Paquera, Ex, Amor)
//   4. NENHUMA outra order com paid_at != NULL existe pro MESMO telefone
//      (com variantes 55X/X sem 9 do celular)
//   5. Nao existe linha em promo_campaigns(order_id, 'namorados_2026')
//      (nunca recebeu essa campanha antes)
//
// Helpers:
//   - listEligible({ limit, beforeId }) — proxima pagina da fila
//   - pickTemplate(order) — escolhe template_key por relationship
//   - renderMessage(order, template_key) — gera o texto do WhatsApp
//   - sendOne(order_id, opts) — envia 1 lead, grava em promo_campaigns
//   - listSent({ limit }) — leads ja enviados (pra dashboard)
//   - stats() — totais (sent, clicked, converted)

const axios = require('axios');
const { supaFetch } = require('./supabase');
const { variants } = require('./phoneVariants');

const CAMPAIGN_NAME = 'namorados_2026';

// Relacionamentos que entram na campanha romantica
const ROMANTIC_RELATIONSHIPS = [
  'Esposo', 'Esposa', 'Esposo(a)', 'Esposa(o)',
  'Namorado', 'Namorada', 'Namorado(a)', 'Namorada(o)',
  'Marido', 'Mulher',
  'Paquera', 'Paquera (ela)', 'Paquera (ele)',
  'Ex', 'Amor',
];

// === FILTRO === //
// Retorna ate `limit` orders elegiveis, ordenadas por created_at DESC
// (leads mais quentes primeiro). `beforeId` permite paginar.
async function listEligible({ limit = 10, beforeCreatedAt = null } = {}) {
  // 1+2+3) preview_sent + paid_at null + relationship romantico
  const relIn = '(' + ROMANTIC_RELATIONSHIPS.map(r => `"${r}"`).join(',') + ')';
  let q = `orders?status=eq.preview_sent&paid_at=is.null` +
          `&relationship=in.${encodeURIComponent(relIn)}` +
          `&select=id,phone,relationship,honoree_name,customer_name,customer_email,preview_audio_url,created_at,genre` +
          `&order=created_at.desc&limit=${Math.max(1, Math.min(limit * 3, 200))}`;
  if (beforeCreatedAt) q += `&created_at=lt.${encodeURIComponent(beforeCreatedAt)}`;
  const candidates = await supaFetch('GET', q) || [];

  // Filtra: pula quem ja recebeu a campanha
  // (busca em batch pra evitar N+1)
  const orderIds = candidates.map(c => c.id);
  if (!orderIds.length) return [];
  const sentRows = await supaFetch('GET',
    `promo_campaigns?order_id=in.(${orderIds.join(',')})` +
    `&campaign_name=eq.${CAMPAIGN_NAME}&select=order_id`) || [];
  const alreadySent = new Set(sentRows.map(r => r.order_id));
  const notSent = candidates.filter(c => !alreadySent.has(c.id));

  // Filtra: pula quem JA pagou alguma vez (qualquer order do mesmo telefone)
  const phonesToCheck = new Set();
  const phoneToOrder = {};
  for (const o of notSent) {
    if (!o.phone) continue;
    const vs = variants(o.phone);
    for (const v of vs) phonesToCheck.add(v);
    phoneToOrder[o.phone] = vs;
  }
  if (!phonesToCheck.size) return notSent.slice(0, limit);

  const phonesList = [...phonesToCheck];
  const paidPhones = new Set();
  // batches de 100 pra nao estourar URL
  for (let i = 0; i < phonesList.length; i += 100) {
    const batch = phonesList.slice(i, i + 100);
    const rows = await supaFetch('GET',
      `orders?phone=in.(${batch.join(',')})&paid_at=not.is.null&select=phone&limit=2000`) || [];
    for (const r of rows) if (r.phone) paidPhones.add(r.phone);
  }

  const eligible = [];
  for (const o of notSent) {
    if (!o.phone) continue;
    const vs = phoneToOrder[o.phone];
    let everPaid = false;
    for (const v of vs) if (paidPhones.has(v)) { everPaid = true; break; }
    if (everPaid) continue;
    eligible.push(o);
    if (eligible.length >= limit) break;
  }
  return eligible;
}

// === TEMPLATE === //
function pickTemplate(order) {
  const rel = (order.relationship || '').toLowerCase();
  if (/esposo|marido/.test(rel))     return 'romantico_esposo';
  if (/esposa|mulher/.test(rel))     return 'romantico_esposa';
  if (/namorado/.test(rel))          return 'romantico_namorado';
  if (/namorada/.test(rel))          return 'romantico_namorada';
  if (/paquera \(ele\)/.test(rel))   return 'romantico_paquera_ele';
  if (/paquera \(ela\)/.test(rel))   return 'romantico_paquera_ela';
  if (/ex/.test(rel))                return 'romantico_ex';
  return 'romantico_generico';
}

function firstName(s) {
  return String(s || '').trim().split(/\s+/)[0] || '';
}

// Gera o texto pro WhatsApp. Recebe order + template_key (opcional).
function renderMessage(order, templateKey = null) {
  const tk = templateKey || pickTemplate(order);
  const customer = firstName(order.customer_name) || '';
  const honoree = (order.honoree_name || '').trim();
  const APP_URL = process.env.APP_URL || 'https://app.lembrancacantada.com';
  const promoUrl = `${APP_URL}/promo/${order.id}`;

  // Cada template segue o padrao:
  // 1) Greet pessoal (cita customer + honoree)
  // 2) Lembra da previa gerada (urgencia)
  // 3) Oferta Dia dos Namorados (R$19,90 + video — so hoje)
  // 4) Link + timer 10min na pagina
  const TEMPLATES = {
    romantico_esposo: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'seu esposo'} e ainda não liberou a versão completa.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma surpresa SÓ HOJE pra você:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `Imagina ${honoree || 'ele'} recebendo essa música com o nome dele cantado + um vídeo lindo pra postar?\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link. Garanta antes de zerar 💕_`,

    romantico_esposa: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'sua esposa'} e ainda não liberou a versão completa.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma surpresa SÓ HOJE pra você:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `Imagina ${honoree || 'ela'} recebendo essa música com o nome dela cantado + um vídeo lindo pra emocionar?\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link. Garanta antes de zerar 💕_`,

    romantico_namorado: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'seu namorado'} e ainda não liberou a versão completa.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma surpresa SÓ HOJE:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `${honoree || 'Ele'} vai surtar quando ouvir o nome dele cantado + ver o vídeo lindo. Presente perfeito pra postar nos stories 💕\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link. Garanta antes de zerar 💕_`,

    romantico_namorada: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'sua namorada'} e ainda não liberou a versão completa.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma surpresa SÓ HOJE:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `${honoree || 'Ela'} vai chorar de emoção. Música com o nome dela + vídeo perfeito pra surpreender 💕\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link. Garanta antes de zerar 💕_`,

    romantico_paquera_ele: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'aquela paquera'} e ainda não liberou.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma surpresa SÓ HOJE:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `Que tal sair do "rolezinho" pra uma declaração inesquecível? 😉\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link 💕_`,

    romantico_paquera_ela: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'aquela paquera'} e ainda não liberou.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma surpresa SÓ HOJE:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `Que tal um movimento ousado? Música personalizada + vídeo lindo. Difícil ela não amar 😍\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link 💕_`,

    romantico_ex: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'essa pessoa especial'}.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma oferta SÓ HOJE:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `Independente de como tá hoje — a música é sua, pra fazer o que sentir vontade 💕\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link._`,

    romantico_generico: () =>
      `Oi${customer ? ', ' + customer : ''}! Aqui é a Bia da Lembrança Cantada 💜\n\n` +
      `Vi que você gerou uma prévia da música pra ${honoree || 'essa pessoa especial'} e ainda não liberou.\n\n` +
      `Como Dia dos Namorados tá chegando 🌹, separei uma surpresa SÓ HOJE:\n\n` +
      `🎁 *R$ 19,90 = Música completa + VÍDEO KARAOKÊ personalizado*\n` +
      `(o vídeo normalmente é R$ 29,90 — hoje vai junto sem pagar a mais)\n\n` +
      `👉 ${promoUrl}\n\n` +
      `_A oferta tem timer de 10 minutos quando você abre o link 💕_`,
  };

  const fn = TEMPLATES[tk] || TEMPLATES.romantico_generico;
  return fn();
}

// === ENVIO === //
// Envia 1 lead via Evolution WhatsApp. Retorna { ok, ... }.
// Se opts.dryRun=true, NAO envia — so retorna o texto que enviaria.
async function sendOne(orderId, opts = {}) {
  const dryRun = !!opts.dryRun;
  const approvedBy = String(opts.approvedBy || 'manual').slice(0, 40);

  // Carrega order completa
  const rows = await supaFetch('GET',
    `orders?id=eq.${orderId}&select=id,phone,relationship,honoree_name,customer_name,customer_email,status,paid_at`);
  const o = Array.isArray(rows) && rows[0];
  if (!o) return { ok: false, reason: 'order nao encontrada' };
  if (o.status !== 'preview_sent' || o.paid_at) {
    return { ok: false, reason: `order nao elegivel (status=${o.status}, paid=${!!o.paid_at})` };
  }
  if (!o.phone) return { ok: false, reason: 'order sem telefone' };

  // Check cross-phone: o MESMO telefone (com variantes) tem alguma order paga?
  // Se sim, esse cliente NAO pode receber a promo (justica com quem ja pagou).
  const phoneVariants = [...variants(o.phone)];
  if (phoneVariants.length) {
    const paidRows = await supaFetch('GET',
      `orders?phone=in.(${phoneVariants.join(',')})&paid_at=not.is.null&select=id&limit=1`);
    if (Array.isArray(paidRows) && paidRows[0]) {
      return {
        ok: false,
        reason: 'cliente ja pagou alguma musica antes — fora da promo',
        already_paid_order_id: paidRows[0].id,
      };
    }
  }

  // Check duplicidade na campanha
  const already = await supaFetch('GET',
    `promo_campaigns?order_id=eq.${orderId}&campaign_name=eq.${CAMPAIGN_NAME}&select=id&limit=1`);
  if (Array.isArray(already) && already[0]) {
    return { ok: false, reason: 'lead ja recebeu essa campanha' };
  }

  const templateKey = pickTemplate(o);
  const text = renderMessage(o, templateKey);

  if (dryRun) {
    return { ok: true, dryRun: true, text, template_key: templateKey, phone: o.phone };
  }

  // Envia via Evolution
  let waOk = false, waErr = null, waStatus = 'queued';
  try {
    const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
    const EVO_KEY = process.env.EVO_KEY || '';
    const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';
    if (!EVO_KEY) throw new Error('EVO_KEY nao configurado');
    const number = o.phone.startsWith('55') ? o.phone : '55' + o.phone;
    await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
      { number, text },
      { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
    waOk = true;
    waStatus = 'sent';
  } catch (e) {
    waErr = e.response?.data?.message || e.response?.data || e.message;
    waStatus = 'failed';
  }

  // Grava na promo_campaigns (sempre — sucesso ou falha)
  try {
    await supaFetch('POST', 'promo_campaigns', {
      order_id: orderId,
      campaign_name: CAMPAIGN_NAME,
      template_key: templateKey,
      whatsapp_sent_at: waOk ? new Date().toISOString() : null,
      whatsapp_status: waStatus,
      whatsapp_error: waErr ? String(waErr).slice(0, 500) : null,
      approved_by: approvedBy,
    });
  } catch (dbErr) {
    console.error('[promoNamorados] grava promo_campaigns falhou:', dbErr.message);
  }

  return { ok: waOk, template_key: templateKey, whatsapp_status: waStatus, error: waErr };
}

// === STATS === //
async function stats() {
  const rows = await supaFetch('GET',
    `promo_campaigns?campaign_name=eq.${CAMPAIGN_NAME}&select=template_key,whatsapp_sent_at,whatsapp_status,link_clicked_at,converted_at&limit=10000`) || [];
  const out = {
    total: rows.length,
    sent: rows.filter(r => r.whatsapp_status === 'sent').length,
    failed: rows.filter(r => r.whatsapp_status === 'failed').length,
    clicked: rows.filter(r => r.link_clicked_at).length,
    converted: rows.filter(r => r.converted_at).length,
    by_template: {},
  };
  for (const r of rows) {
    out.by_template[r.template_key] = (out.by_template[r.template_key] || 0) + 1;
  }
  return out;
}

module.exports = {
  CAMPAIGN_NAME,
  ROMANTIC_RELATIONSHIPS,
  listEligible,
  pickTemplate,
  renderMessage,
  sendOne,
  stats,
};
