// CAMPANHAS AUTOMÁTICAS por estágio do funil (lead_stage). Sistema outbound unificado:
// conforme o lead anda no funil, as campanhas disparam sozinhas na cadência certa.
// ESCOPO: só leads de hoje em diante (CAMPAIGN_SINCE) — não toca o backlog antigo.
// Segurança: dedup por tag, respeita bot_paused_phones, filtra teste/junk, teto por run,
// 1 campanha por lead por execução. NÃO toca no n8n — quando o lead responde, o agente assume.
// Substitui o funil de recuperação antigo (recoveryFunnel) — desligar RECOVERY_ENABLED.
const axios = require('axios');
const { supaFetch } = require('./supabase');

const EVO_URL = process.env.EVO_URL || 'https://evolution.bvph.uk';
const EVO_KEY = process.env.EVO_KEY || '';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno';
const TEST_PHONES = new Set(['11915391862', '5511915391862', '11915301862', '5511915301862',
  '5511999999999', '5511920188319']);
// só recupera/captura leads cuja jornada começou a partir desta data (decisão do dono).
const CAMPAIGN_SINCE = process.env.CAMPAIGN_SINCE || '2026-06-01';

const PRECO_NORMAL = 'R$19,90'; // preço real atual (cobrança/recuperação)
const PRECO_ANCORA = 'R$39,90'; // âncora riscada ("era R$39,90") só pra promos
const PRECO_PROMO = 'R$19,90'; // piso autorizado pelo dono (máx desconto)

let _timer = null;
let _running = false;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _digits = (p) => String(p || '').replace(/\D/g, '');
function _normPhone(p) {
  const d = _digits(p);
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

// Campanhas (keyed por id). stage = lead_stage alvo · tag = dedup.
const CAMPAIGNS = {
  nudge: {
    stage: 'aguardando_aprovacao', tag: 'camp_nudge', label: 'Nudge "gostou da prévia?"',
    msg: () => `Oi! 💜 E aí, o que você achou da prévia da sua música? 🥰\n\nFiz com muito carinho e ela está aqui pronta te esperando 🎵\n\nSe curtiu, eu libero a *versão completa* + um *vídeo de brinde* com a letra pra você emocionar quem você ama — por *${PRECO_NORMAL}* 💝\n\nÉ só responder *SIM* que eu preparo tudo! ✨`,
  },
  recuperacao: {
    stage: 'aguardando_pagamento', tag: 'camp_recuperacao', label: 'Recuperação de carrinho (hot)',
    msg: () => `Oi! 💜 Vi que sua música tá só esperando o pagamento pra ser liberada 🥺🎵\n\nEla ficou *linda* e está pronta! É só *${PRECO_NORMAL}* no PIX que eu libero a *completa* + o *vídeo de brinde* na hora 💝\n\nQuer que eu te mande o PIX de novo? Responde *SIM* 🎁`,
  },
  promo: {
    stage: 'desinteressado', tag: 'camp_promo', label: 'Promo 50% (R$19,90) — 1º toque',
    msg: () => `🔥 *SÓ HOJE: sua música pela METADE do preço!* 💜\n\nOi! Aqui é a Bia da *Lembrança Cantada* 🎵 Sua música personalizada já está *PRONTA* aqui — só faltou você liberar 🥺\n\nSeparei uma condição que eu *raramente* faço:\n✨ Música *completa* + *vídeo de brinde* por só *${PRECO_PROMO}* (era ${PRECO_ANCORA} — *50% OFF*!)\n\nImagina a reação de quem vai receber essa homenagem feita com tanto carinho...\n\n👉 Responde *SIM* que eu libero na hora! 🎁`,
  },
  promo_ultima: {
    stage: 'desinteressado', tag: 'camp_promo_ultima', label: 'Última chamada (R$19,90) — 2º toque',
    msg: () => `⏰ *ÚLTIMA CHAMADA* 💔\n\nOi! É a Bia de novo 💜 A condição especial da música da sua pessoa querida está *acabando*...\n\nDepois volta pros ${PRECO_ANCORA}. Seria uma pena deixar essa homenagem pronta esquecida 🥺🎵\n\n🔥 Última chance: *completa + vídeo* por *${PRECO_PROMO}*.\n\nResponde *SIM* agora que eu garanto pra você 🎁💜`,
  },
  recompra: {
    stage: 'concluido', tag: 'camp_recompra', label: 'Recompra/indicação',
    msg: () => `Oi! 💜 Que alegria te ver de novo! Aqui é a Bia da *Lembrança Cantada* 🎵\n\nSua música ficou especial, né? 🥹 Que tal surpreender *mais alguém* que você ama? Um aniversário, uma data marcante, ou só pra dizer "te amo"...\n\nComo você já é da nossa família, faço com todo carinho 💝\n\nQuer criar outra? Me chama que a gente faz mágica de novo! ✨`,
  },
};

// Cadência automática: quando cada campanha dispara (horas desde stage_updated_at).
// requires = só dispara se o lead já tem essa tag (ex: última chamada só depois da promo).
const CADENCE = [
  { campaign: 'recuperacao', afterH: 1 },
  { campaign: 'nudge', afterH: 3 },
  { campaign: 'promo', afterH: 0 },
  { campaign: 'promo_ultima', afterH: 48, requires: 'camp_promo' },
  { campaign: 'recompra', afterH: 120 },
];

function _isJunk(o) {
  const d = _digits(o.phone);
  if (!d || d.length < 10) return true;
  if (TEST_PHONES.has(d)) return true;
  const name = String(o.honoree_name || '').toLowerCase();
  if (name.includes('teste') || name.includes('seguranc')) return true;
  return false;
}

async function _isPaused(phone) {
  const d = _digits(phone);
  for (const v of [d, '55' + d, d.replace(/^55/, '')]) {
    if (!v) continue;
    const r = await supaFetch('GET', `bot_paused_phones?phone=eq.${encodeURIComponent(v)}&select=phone&limit=1`);
    if (Array.isArray(r) && r.length) return true;
  }
  return false;
}

async function _sendText(phone, text) {
  await axios.post(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, { number: _normPhone(phone), text },
    { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
}

async function _markSent(o, tag) {
  const cur = Array.isArray(o.tags) ? o.tags : [];
  if (cur.includes(tag)) return;
  const next = Array.from(new Set([...cur, tag])).sort();
  await supaFetch('PATCH', `orders?id=eq.${o.id}`, { tags: next });
  o.tags = next; // atualiza em memória pra não reenviar no mesmo run
}

const _hasTag = (o, t) => Array.isArray(o.tags) && o.tags.includes(t);

// ===== CRON AUTOMÁTICO: dispara campanhas conforme a cadência, só leads de hoje =====
// Horário de silêncio: NUNCA dispara mensagem proativa fora do horário comercial (Brasília).
// Default 08h–21h. Configurável via OUTBOUND_START_HOUR / OUTBOUND_END_HOUR.
function _isQuietHours() {
  const startH = parseInt(process.env.OUTBOUND_START_HOUR || '8', 10);
  const endH = parseInt(process.env.OUTBOUND_END_HOUR || '21', 10);
  const brHour = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
  return brHour < startH || brHour >= endH;
}

async function runCampaignsAuto(opts = {}) {
  if (_running) return { skipped: 'já rodando' };
  if (!opts.force && !opts.dryRun && _isQuietHours()) {
    console.log('[Campaigns] horário de silêncio (fora 08h–21h BR) — pulando tick, sem disparar nada');
    return { skipped: 'horario_silencio' };
  }
  _running = true;
  const dryRun = opts.dryRun === true;
  const maxRun = opts.max != null ? opts.max : parseInt(process.env.CAMPAIGN_MAX_PER_RUN || '8', 10);
  const nowMs = Date.now();
  const report = { dryRun, enviados: 0, pulados: 0, byCampaign: {}, detalhes: [] };
  try {
    const leads = await supaFetch('GET',
      `orders?created_at=gte.${CAMPAIGN_SINCE}&phone=not.is.null&select=id,phone,honoree_name,tags,lead_stage,stage_updated_at&order=stage_updated_at.asc&limit=2000`);
    if (!Array.isArray(leads)) return { ...report, erro: 'query falhou' };
    for (const o of leads) {
      if (report.enviados >= maxRun) { report.detalhes.push({ skip: 'teto atingido' }); break; }
      if (_isJunk(o)) continue;
      const rules = CADENCE.filter((c) => CAMPAIGNS[c.campaign].stage === o.lead_stage);
      for (const rule of rules) {
        const camp = CAMPAIGNS[rule.campaign];
        if (_hasTag(o, camp.tag)) continue;                                  // já recebeu
        if (rule.requires && !_hasTag(o, rule.requires)) continue;           // pré-requisito não cumprido
        const ageH = o.stage_updated_at ? (nowMs - new Date(o.stage_updated_at).getTime()) / 3600000 : 0;
        if (ageH < rule.afterH) continue;                                    // ainda não é hora
        if (await _isPaused(o.phone)) { report.pulados++; break; }
        if (dryRun) {
          report.detalhes.push({ campaign: rule.campaign, honoree: o.honoree_name, phone: o.phone });
          report.byCampaign[rule.campaign] = (report.byCampaign[rule.campaign] || 0) + 1;
          break;
        }
        try {
          await _sendText(o.phone, camp.msg(o));
          await _markSent(o, camp.tag);
          report.enviados++;
          report.byCampaign[rule.campaign] = (report.byCampaign[rule.campaign] || 0) + 1;
          report.detalhes.push({ campaign: rule.campaign, honoree: o.honoree_name, enviado: true });
          await _sleep(2500);
        } catch (e) { report.detalhes.push({ phone: o.phone, erro: e.message }); }
        break; // 1 campanha por lead por execução
      }
    }
    console.log(`[Campaigns] auto: enviados=${report.enviados} dryRun=${dryRun} ${JSON.stringify(report.byCampaign)}`);
    return report;
  } catch (e) {
    console.error('[Campaigns] erro:', e.message);
    return { ...report, erro: e.message };
  } finally {
    _running = false;
  }
}

// Disparo MANUAL de UMA campanha específica (teste/controle). opts: { campaign, dryRun, testPhone, max }
async function runCampaign(opts = {}) {
  const camp = CAMPAIGNS[opts.campaign];
  if (!camp) return { erro: `campanha inválida. válidas: ${Object.keys(CAMPAIGNS).join(', ')}` };
  const stage = camp.stage;
  const dryRun = opts.dryRun !== false;
  const onlyPhone = opts.testPhone ? _digits(opts.testPhone) : null;
  const max = opts.max != null ? opts.max : parseInt(process.env.CAMPAIGN_MAX_PER_RUN || '8', 10);
  const report = { campaign: opts.campaign, stage, dryRun, enviados: 0, pulados: 0, elegiveis: 0, detalhes: [] };
  try {
    // só leads de hoje em diante (mesmo no manual) — a não ser que peça backlog explicitamente
    const sinceFilter = opts.all ? '' : `&created_at=gte.${CAMPAIGN_SINCE}`;
    const leads = await supaFetch('GET',
      `orders?lead_stage=eq.${stage}&phone=not.is.null${sinceFilter}&select=id,phone,honoree_name,tags&order=stage_updated_at.desc&limit=500`);
    if (!Array.isArray(leads)) return { ...report, erro: 'query falhou' };
    for (const o of leads) {
      if (report.enviados >= max) { report.detalhes.push({ skip: 'teto atingido' }); break; }
      if (_isJunk(o)) { report.pulados++; continue; }
      if (onlyPhone && _digits(o.phone) !== onlyPhone) { report.pulados++; continue; }
      if (_hasTag(o, camp.tag)) { report.pulados++; continue; }
      if (await _isPaused(o.phone)) { report.pulados++; continue; }
      report.elegiveis++;
      if (dryRun) { report.detalhes.push({ honoree: o.honoree_name, phone: o.phone, preview: camp.msg(o).slice(0, 70) }); continue; }
      try {
        await _sendText(o.phone, camp.msg(o));
        await _markSent(o, camp.tag);
        report.enviados++;
        report.detalhes.push({ honoree: o.honoree_name, phone: o.phone, enviado: true });
        await _sleep(2500);
      } catch (e) { report.detalhes.push({ phone: o.phone, erro: e.message }); }
    }
    return report;
  } catch (e) { return { ...report, erro: e.message }; }
}

function startCampaignCron() {
  if (_timer) return;
  if (String(process.env.CAMPAIGN_AUTO_ENABLED).toLowerCase() !== 'true') {
    console.log('[Campaigns] cron AUTO OFF (defina CAMPAIGN_AUTO_ENABLED=true)');
    return;
  }
  const min = parseInt(process.env.CAMPAIGN_INTERVAL_MIN || '30', 10);
  console.log(`[Campaigns] ✅ cron AUTO ON — a cada ${min}min (desde ${CAMPAIGN_SINCE})`);
  setTimeout(() => {
    runCampaignsAuto();
    _timer = setInterval(runCampaignsAuto, Math.max(5, min) * 60 * 1000);
  }, 120000);
}

module.exports = { runCampaign, runCampaignsAuto, startCampaignCron, CAMPAIGNS, CADENCE };
