// orderEditRoutes — AUTO-EDIÇÃO da música pelo próprio cliente (self-edit).
//
// O cliente (pago) ajusta a própria música 1 vez, igual o admin faz no CRM:
//   • gera nova letra até 3× (GPT) — por DADOS (nome/história/ritmo/ocasião/voz)
//     ou por INSTRUÇÃO livre ("troca o nome pra X, deixa mais alegre")
//   • edita o texto da letra à vontade (client-side, sem custo)
//   • confirma 1× → dispara a regeneração (Inngest regenerateEditedSong) que
//     mantém as 2 versões antigas e cria 2 novas + (plano completa) vídeo novo
//
// Travas server-side (fonte de verdade, o front é só espelho):
//   • paid_at obrigatório
//   • self_edit_used === true → 409 (só 1 música nova por pedido)
//   • lyric_regen_count >= 3 → 429 (só 3 letras)
//
// Rotas:
//   POST /api/order/:id/edit/lyrics   — gera/edita a letra (conta no limite de 3)
//   POST /api/order/:id/edit/confirm  — confirma a letra e dispara a nova música
const express = require('express');
const router = express.Router();

const { supaFetch } = require('../lib/supabase');
const { isUuid: _isUuid, clip: _clip } = require('../lib/validators');
const { generateLyricsWithGPT, editLyricsWithGPT } = require('../lib/openai');
const { clipCdnUrl } = require('../lib/sunoApi');
const { inngest } = require('../inngest/client');

const MAX_LYRIC_GENS = 3;
// Pills do front ("Feminina"/"Masculina") → valor do sistema ("Feminino"/"Masculino").
const normVoice = (v) => { const s = String(v || '').toLowerCase(); return s.startsWith('masc') ? 'Masculino' : s.startsWith('fem') ? 'Feminino' : (v || null); };

// ── POST /api/order/:id/edit/lyrics ──────────────────────────────────────────
router.post('/api/order/:id/edit/lyrics', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    const rows = await supaFetch('GET', `orders?id=eq.${id}&select=id,paid_at,preview_audio_url,self_edit_used,lyric_regen_count,honoree_name,relationship,occasion,genre,mood,voice_preference,story,final_lyrics,style_raw`);
    const o = Array.isArray(rows) && rows[0];
    if (!o) return res.status(404).json({ error: 'nao encontrado' });
    // Pode editar quem PAGOU (ajusta a música) OU quem tem PRÉVIA (ajusta a prévia, ainda vai pagar).
    if (!o.paid_at && !o.preview_audio_url) return res.status(403).json({ error: 'not_ready', message: 'pedido ainda não tem prévia' });
    if (o.self_edit_used) return res.status(409).json({ error: 'already_used', message: 'você já criou sua nova música' });
    const used = Number(o.lyric_regen_count) || 0;
    if (used >= MAX_LYRIC_GENS) return res.status(429).json({ error: 'limit_reached', message: 'limite de gerações de letra atingido', remaining: 0 });

    const mode = String(req.body?.mode || 'data');
    const fields = (req.body && typeof req.body.fields === 'object') ? req.body.fields : {};
    let lyrics;
    if (mode === 'instruction') {
      const instruction = _clip(req.body?.instruction || '', 500);
      const current = _clip(req.body?.currentLyrics || o.final_lyrics || '', 6000);
      if (!instruction.trim()) return res.status(400).json({ error: 'instrucao vazia' });
      if (!current.trim()) return res.status(400).json({ error: 'sem letra base' });
      lyrics = await editLyricsWithGPT(current, instruction);
    } else {
      // modo DADOS — usa os campos editados (fallback pro pedido)
      const story = _clip(fields.story || o.story || '', 6000);
      if (!story.trim()) return res.status(400).json({ error: 'sem historia' });
      lyrics = await generateLyricsWithGPT(story, {
        honoreeName: _clip(fields.honoree_name || o.honoree_name || '', 120),
        relationship: o.relationship || '',
        occasion: _clip(fields.occasion || o.occasion || '', 200),
        genre: _clip(fields.genre || o.genre || o.style_raw || '', 80),
        mood: o.mood || '',
        voice: normVoice(fields.voice || o.voice_preference),
      });
    }

    // Incrementa o contador (trava real). Best-effort: se falhar, ainda devolve a letra.
    const newCount = used + 1;
    try { await supaFetch('PATCH', `orders?id=eq.${id}`, { lyric_regen_count: newCount }); } catch (_) {}
    res.json({ ok: true, lyrics, remaining: Math.max(0, MAX_LYRIC_GENS - newCount) });
  } catch (e) {
    console.error('[/edit/lyrics] erro:', e.message);
    res.status(500).json({ error: 'erro ao gerar letra', message: 'não consegui gerar a letra agora, tenta de novo em instantes' });
  }
});

// ── POST /api/order/:id/edit/confirm ─────────────────────────────────────────
router.post('/api/order/:id/edit/confirm', async (req, res) => {
  try {
    const id = req.params.id;
    if (!_isUuid(id)) return res.status(400).json({ error: 'id invalido' });
    const rows = await supaFetch('GET', `orders?id=eq.${id}&select=id,paid_at,preview_audio_url,self_edit_used,full_audio_urls,original_audio_url,prev_audio_urls,suno_clip_ids`);
    const o = Array.isArray(rows) && rows[0];
    if (!o) return res.status(404).json({ error: 'nao encontrado' });
    if (!o.paid_at && !o.preview_audio_url) return res.status(403).json({ error: 'not_ready' });
    if (o.self_edit_used) return res.status(409).json({ error: 'already_used', message: 'você já criou sua nova música' });

    const lyrics = _clip(req.body?.lyrics || '', 6000);
    if (!lyrics.trim()) return res.status(400).json({ error: 'sem letra' });
    const fields = (req.body && typeof req.body.fields === 'object') ? req.body.fields : {};

    // Snapshot das versões ATUAIS → prev_audio_urls. Preferimos montar do
    // suno_clip_ids como link PERMANENTE (cdn1) — assim as originais NÃO expiram
    // no painel (o full_audio_urls pode ser um tempfile antigo já morto). Fallback
    // pro full_audio_urls/original só se não tiver clip id.
    const clipIds = Array.isArray(o.suno_clip_ids) ? o.suno_clip_ids.filter(Boolean) : [];
    const curVersions = clipIds.length
      ? clipIds.map(clipCdnUrl).filter(Boolean)
      : ((Array.isArray(o.full_audio_urls) && o.full_audio_urls.filter(Boolean).length)
          ? o.full_audio_urls.filter(Boolean)
          : (o.original_audio_url ? [o.original_audio_url] : []));
    const prev = (Array.isArray(o.prev_audio_urls) && o.prev_audio_urls.length) ? o.prev_audio_urls : curVersions;

    const patch = {
      prev_audio_urls: prev,
      final_lyrics: lyrics,
      self_edit_used: true,
      edit_status: 'regenerating',
      edit_requested_at: new Date().toISOString(),
    };
    // Persiste dados editados (se vieram) — a nova música reflete eles.
    if (fields.honoree_name) patch.honoree_name = _clip(fields.honoree_name, 120);
    if (fields.story) patch.story = _clip(fields.story, 6000);
    if (fields.genre) patch.genre = _clip(fields.genre, 80);
    if (fields.occasion) patch.occasion = _clip(fields.occasion, 200);
    if (fields.voice) patch.voice_preference = normVoice(fields.voice);

    await supaFetch('PATCH', `orders?id=eq.${id}`, patch);

    // Dispara a regeneração isolada (Inngest). editNonce = idempotência única.
    await inngest.send({
      name: 'song/edit.requested',
      data: { orderId: id, lyrics, editNonce: Date.now() },
    });

    console.log('[/edit/confirm] ✅ regeneração disparada order', id);
    res.json({ ok: true, status: 'regenerating' });
  } catch (e) {
    console.error('[/edit/confirm] erro:', e.message);
    res.status(500).json({ error: 'erro ao confirmar', message: 'não consegui iniciar a criação agora, tenta de novo' });
  }
});

module.exports = router;
