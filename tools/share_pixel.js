#!/usr/bin/env node
// share_pixel — compartilha um pixel Meta com 1+ contas de anuncio via Marketing API.
//
// Funciona com pixels criados em contas pessoais (sem precisar de BP).
// Pre-requisitos:
//   - Token de usuario long-lived com escopo `ads_management` (gerado via
//     App proprio em developers.facebook.com -> Graph API Explorer)
//   - Voce precisa ser DONO do pixel (criou no seu Facebook)
//   - Voce precisa ter algum role (admin/analyst/etc) na conta-alvo
//
// Uso:
//   node tools/share_pixel.js --pixel 123 --account 456 --token EAAxxx
//   node tools/share_pixel.js --pixel 123 --account 456,789,012   # multiplas contas
//   node tools/share_pixel.js --pixel 123 --list                  # lista compartilhamentos atuais
//   node tools/share_pixel.js --pixel 123 --account 456 --remove  # remove compartilhamento
//
// Token tambem pode vir do env META_USER_TOKEN ou de um arquivo .meta_token na raiz do backend.

const fs = require('fs');
const path = require('path');

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// fetch wrapper que trata o erro do Graph API de forma decente.
// Lanca um Error com .graphError populado pra quem chamou inspecionar.
async function gfetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  let body;
  try { body = await r.json(); }
  catch (_) { body = { error: { message: 'resposta nao-JSON: ' + r.status } }; }
  if (!r.ok || body?.error) {
    const e = new Error(body?.error?.message || `HTTP ${r.status}`);
    e.graphError = body?.error || { message: e.message };
    throw e;
  }
  return body;
}

function qs(params) {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ────── parse args ──────
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list')   { out.list = true; continue; }
    if (a === '--remove') { out.remove = true; continue; }
    if (a === '--quiet')  { out.quiet = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else                                  { out[key] = true; }
    }
  }
  return out;
}

// ────── load token: --token > env > .meta_token file ──────
function resolveToken(arg) {
  if (arg && typeof arg === 'string') return arg.trim();
  if (process.env.META_USER_TOKEN)    return process.env.META_USER_TOKEN.trim();
  const f = path.join(__dirname, '..', '.meta_token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

function bail(msg, code = 1) {
  console.error('❌ ' + msg);
  process.exit(code);
}

// ────── operacoes ──────
async function listShared(pixelId, token) {
  return gfetch(`${GRAPH_BASE}/${pixelId}/shared_accounts?${qs({ access_token: token, fields: 'id,name,account_status' })}`);
}

async function shareWith(pixelId, accountId, token, business) {
  // account_id deve vir sem o prefixo "act_". `business` e o ID do BM dono do
  // pixel — obrigatorio quando o pixel vive num BM e voce compartilha com
  // uma conta de anuncios pessoal (fora desse BM).
  const cleaned = String(accountId).replace(/^act_/, '');
  return gfetch(`${GRAPH_BASE}/${pixelId}/shared_accounts?${qs({ access_token: token, account_id: cleaned, business })}`, { method: 'POST' });
}

async function unshare(pixelId, accountId, token, business) {
  const cleaned = String(accountId).replace(/^act_/, '');
  return gfetch(`${GRAPH_BASE}/${pixelId}/shared_accounts?${qs({ access_token: token, account_id: cleaned, business })}`, { method: 'DELETE' });
}

async function pixelInfo(pixelId, token) {
  return gfetch(`${GRAPH_BASE}/${pixelId}?${qs({ access_token: token, fields: 'id,name,owner_business,owner_ad_account,creation_time' })}`);
}

// ────── main ──────
(async () => {
  const args = parseArgs(process.argv);

  if (args.help || (!args.pixel && !args.list)) {
    console.log(`
share_pixel — compartilha pixel Meta com contas de anuncio

Uso:
  node tools/share_pixel.js --pixel <id> --account <id>           # compartilha
  node tools/share_pixel.js --pixel <id> --account <id1,id2,id3>  # multiplas
  node tools/share_pixel.js --pixel <id> --list                    # lista atual
  node tools/share_pixel.js --pixel <id> --account <id> --remove   # remove

Flags:
  --pixel     ID do pixel (obrigatorio)
  --account   ID da conta de anuncio (sem prefixo act_) — pode ser CSV
  --business  ID do BM dono do pixel (obrigatorio se pixel vive num BM)
  --list      so lista as contas atualmente compartilhadas
  --remove    remove o compartilhamento da conta passada
  --token     token de acesso (senao usa env META_USER_TOKEN ou .meta_token)
  --quiet     so imprime erros

Env:
  META_USER_TOKEN   token de usuario long-lived (alternativa ao --token)
  GRAPH_VERSION     versao da Graph API (default ${GRAPH_VERSION})
`);
    process.exit(args.help ? 0 : 1);
  }

  const token = resolveToken(args.token);
  if (!token) bail('Token nao encontrado. Passe --token, defina META_USER_TOKEN, ou crie .meta_token na raiz do backend.');

  const pixelId = String(args.pixel).trim();
  if (!/^\d+$/.test(pixelId)) bail(`pixel-id invalido: "${pixelId}" (esperado so digitos)`);

  // ── info do pixel pra sanity check ──
  if (!args.quiet) {
    try {
      const info = await pixelInfo(pixelId, token);
      console.log(`Pixel: ${info.name || '(sem nome)'} (${info.id})`);
      if (info.owner_business)    console.log(`  owner_business: ${info.owner_business.name || info.owner_business.id}`);
      if (info.owner_ad_account)  console.log(`  owner_ad_account: act_${info.owner_ad_account.id}`);
    } catch (e) {
      bail(`falha ao buscar info do pixel: ${e.graphError?.message || e.message}`);
    }
  }

  // ── LIST ──
  if (args.list) {
    try {
      const r = await listShared(pixelId, token);
      const arr = r.data || [];
      console.log(`\n${arr.length} conta(s) compartilhada(s):`);
      for (const a of arr) {
        console.log(`  act_${a.id}  ${a.name || ''}  ${a.account_status != null ? `(status=${a.account_status})` : ''}`);
      }
      if (!arr.length) console.log('  (nenhuma)');
    } catch (e) {
      bail(`falha ao listar: ${e.graphError?.message || e.message}`);
    }
    return;
  }

  // ── SHARE / REMOVE ──
  if (!args.account) bail('--account obrigatorio (ou use --list)');
  const accounts = String(args.account).split(',').map(s => s.trim()).filter(Boolean);

  let okCount = 0, failCount = 0;
  for (const acc of accounts) {
    try {
      const r = args.remove
        ? await unshare(pixelId, acc, token, args.business)
        : await shareWith(pixelId, acc, token, args.business);
      const verb = args.remove ? 'removido' : 'compartilhado';
      console.log(`✅ ${verb}: pixel ${pixelId} <-> act_${acc.replace(/^act_/, '')}  ${JSON.stringify(r)}`);
      okCount++;
    } catch (e) {
      const msg  = e.graphError?.message || e.message;
      const sub  = e.graphError?.error_subcode;
      const code = e.graphError?.code;
      console.error(`❌ falha em act_${acc}: ${msg}` + (code ? ` (code=${code} sub=${sub})` : ''));
      failCount++;
    }
  }
  console.log(`\nresumo: ${okCount} ok, ${failCount} falhou`);
  if (failCount > 0) process.exit(2);
})().catch(e => bail(e.message));
