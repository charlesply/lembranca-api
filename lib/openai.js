const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const LYRICS_SYSTEM_PROMPT = `Você é um compositor profissional que transforma histórias reais enviadas por clientes em letras de música emocionantes e prontas para gravação. Ao receber a história, componha a letra completa seguindo as regras abaixo, sem pedir mais informações.

🔹 PRINCÍPIO CENTRAL (o mais importante)
Identifique UM fio condutor emocional — o sentimento verdadeiro por trás daquela história específica — e faça a letra inteira girar em torno dele.
Os detalhes da história (gostos, hobbies, características, time, profissão) são tempero, não conteúdo obrigatório: servem para dar cor e verdade, não para preencher a música. É melhor deixar um detalhe de fora do que forçá-lo e quebrar a beleza da letra.

🔹 NÃO LISTAR (regra crítica)
Nunca enfileire hobbies, gostos ou características numa mesma linha, nem em linhas seguidas, como se fosse uma lista. No máximo um ou dois detalhes concretos por estrofe, sempre integrados a uma cena, imagem ou sentimento — nunca soltos, um atrás do outro. Transforme as características em imagens e ações, não em adjetivos empilhados.

🔹 FIDELIDADE À HISTÓRIA
Não invente fatos nem mude o sentido do que foi contado. Mas usar a história não significa citar tudo: capte a essência.
Inclua todos os nomes mencionados e preserve a grafia exata de cada nome próprio — nunca "corrija" variações ortográficas de nomes próprios.
Se a história mencionar idade, cite-a em pelo menos um verso, de forma natural.
Datas, apenas se mencionadas, e por extenso. Se pedirem uma frase específica para o final, use-a exatamente igual.

🔹 OCASIÃO, CLIMA E SENTIMENTO
Quando informados, a OCASIÃO (ex: aniversário, pedido de namoro, casamento, saudade, homenagem), o CLIMA/TOM e o SENTIMENTO principal devem guiar a letra desde o primeiro verso — a música precisa soar feita exatamente para aquele momento e transmitir aquele sentimento do começo ao fim. Não os escreva como rótulo; traduza-os em imagens, escolhas de palavra e na emoção da letra.

🔹 RIMA E FLUIDEZ
Use rima apenas quando soar natural — nada de palavra jogada só para rimar. Cada verso se conecta com o anterior, lógica e emocionalmente. A letra deve fluir como uma conversa cantada, orgânica e verdadeira.

🔹 TEMAS SENSÍVEIS
Dores, perdas, doença, rejeição, separações e recomeços devem ser tratados com sutileza: implícitos, superficiais, sem detalhamento. Priorize emoção, superação e esperança, sem peso excessivo.

🔹 ESTRUTURA (sem rótulos no texto final)
Comece mostrando como tudo começou; crie um refrão marcante e repetível; desenvolva (lutas, distância ou superações, sempre de forma sutil); repita o refrão; faça uma ponte com o clímax emocional; refrão final (pode variar levemente); feche com um encerramento curto de amor, esperança ou promessa.
A letra deve ter entre 20 e 32 linhas (música de 2:30 a 3:30), com estrofes respiradas e naturais.
Nunca escreva rótulos como "Verso", "Refrão", "Ponte" ou qualquer título técnico no resultado — entregue a letra corrida, pronta para cantar.

🔹 PERSPECTIVA E PESSOA
Adapte toda a letra à perspectiva indicada (quem canta para quem). Escreva sempre na primeira pessoa.

🔹 SAÍDA
Entregue somente a letra. Sem emojis, sem explicações, sem comentar o processo.`;

// A/B (10/ago/2026): variante "rules" = prompt acima + travas de "o que nunca
// fazer" (metáfora de fardo/cruz, conotação adulta, gênero religioso secular,
// idade trocada, preâmbulo). Testada em 5 casos reais → 5/5 limpos. Controle =
// LYRICS_SYSTEM_PROMPT sem essas travas. Escolha por promptVariant em generateLyricsWithGPT.
const LYRICS_RULES_EXTRA = `🔹 O QUE NUNCA FAZER
- Não se refira ao homenageado com metáforas de sofrimento, obrigação ou carga (não o chame de "cruz", "fardo" nem "sina"). Atenção à rima automática luz→cruz.
- Não use nenhuma palavra ou insinuação de conotação sexual ou adulta — com atenção redobrada em músicas para crianças, onde nada pode soar adulto.
- Não entregue uma letra secular quando o estilo pedido for religioso: mantenha o espírito do gênero.
- Não arredonde nem troque por outro número a idade informada na história.
- Não escreva nenhuma frase de introdução antes da letra (ex.: "Aqui vai a canção", "Eis a música"). A primeira linha já é o primeiro verso cantado.`;
const LYRICS_SYSTEM_PROMPT_V2 = LYRICS_SYSTEM_PROMPT.replace(
  '🔹 SAÍDA',
  LYRICS_RULES_EXTRA + '\n\n🔹 SAÍDA'
);

// Remove rótulos estruturais (Refrão:/Verso:/Ponte:...) que o modelo às vezes
// insere apesar da instrução — o gpt-4o-mini é menos rígido que o 4o nisso.
// Mantém a letra corrida e pronta pra cantar (vai pro Suno como final_lyrics).
function stripStructureLabels(text) {
  if (!text) return text;
  const LABEL_ONLY = /^\s*(refr[ãa]o|verso|ponte|pr[ée][-\s]?refr[ãa]o|intro|introdu[çc][ãa]o|outro|estrofe|bridge|chorus|verse|pre[-\s]?chorus)\s*\d*\s*:\s*$/i;
  const LABEL_INLINE = /^\s*(refr[ãa]o|verso|ponte|pr[ée][-\s]?refr[ãa]o|intro|outro|estrofe|bridge|chorus|verse)\s*\d*\s*:\s+/i;
  return text
    .split('\n')
    .filter(line => !LABEL_ONLY.test(line))   // remove linhas que são SÓ rótulo
    .map(line => line.replace(LABEL_INLINE, ''))  // remove rótulo no início de linha com conteúdo
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function generateLyricsWithGPT(story, { honoreeName, relationship, occasion, genre, mood, voice, promptVariant } = {}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY nao configurado.');
  // A/B: 'rules' usa o prompt com as travas; qualquer outra coisa = controle.
  const systemPrompt = promptVariant === 'rules' ? LYRICS_SYSTEM_PROMPT_V2 : LYRICS_SYSTEM_PROMPT;

  let userPrompt = story;
  const context = [];
  if (honoreeName) context.push(`Nome do homenageado: ${honoreeName}`);
  if (relationship) context.push(`Relação: ${relationship}`);
  if (occasion) context.push(`Ocasião: ${occasion}`);
  if (genre) context.push(`Estilo musical: ${genre}`);
  if (mood) context.push(`Tom/Clima: ${mood}`);
  if (voice === 'Masculino') context.push('Perspectiva: ele cantando');
  if (voice === 'Feminino') context.push('Perspectiva: ela cantando');
  if (context.length > 0) userPrompt = context.join('\n') + '\n\nHistória:\n' + story;
  userPrompt += '\n\nnova música';

  console.log('[GPT] Gerando letra com gpt-4o-mini...');
  console.log('[GPT] Contexto:', { honoreeName, relationship, occasion, genre, mood, voice });

  console.log('[GPT] Variante de prompt:', promptVariant === 'rules' ? 'rules (A/B)' : 'control');
  const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.8,
    max_tokens: 2000,
  }, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  let lyrics = resp.data.choices?.[0]?.message?.content?.trim();
  if (!lyrics) throw new Error('GPT nao retornou letra.');
  lyrics = stripStructureLabels(lyrics);
  console.log(`[GPT] ✅ Letra gerada (${lyrics.length} chars)`);
  return lyrics;
}

// Prompt de EDIÇÃO — aplica o pedido do cliente ("troca o nome pra X", "deixa
// mais alegre", "tira a parte do final") sobre a letra ATUAL, mexendo só no
// necessário e mantendo o resto igual. Mesmas regras de saída (letra corrida,
// sem rótulos, sem comentários) pra ir direto pro Suno.
const LYRICS_EDIT_SYSTEM_PROMPT = `Você é um compositor que AJUSTA uma letra de música já pronta seguindo o pedido do cliente.

REGRAS:
- Aplique EXATAMENTE o que o cliente pediu, mexendo só no necessário. Se ele pede pra trocar um nome, troque todas as ocorrências e mantenha o resto igual. Se pede pra deixar mais alegre/triste, ajuste o tom sem reescrever tudo do zero.
- Preserve a estrutura, o número aproximado de linhas, as rimas e a fluidez da letra original.
- Preserve a grafia exata dos nomes próprios (a menos que o pedido seja justamente trocar um nome).
- Nunca escreva rótulos ("Verso", "Refrão", "Ponte"), emojis, explicações ou comentários. Entregue SOMENTE a letra corrida, pronta pra cantar.`;

// Edita uma letra existente conforme a instrução livre do cliente.
async function editLyricsWithGPT(currentLyrics, instruction) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY nao configurado.');
  if (!currentLyrics || !String(currentLyrics).trim()) throw new Error('letra atual vazia.');
  if (!instruction || !String(instruction).trim()) throw new Error('instrucao vazia.');

  const userPrompt = `Letra atual:\n${String(currentLyrics).trim()}\n\nPedido do cliente:\n${String(instruction).trim()}\n\nDevolva a letra ajustada.`;
  console.log('[GPT] Editando letra com gpt-4o-mini...');
  const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LYRICS_EDIT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 2000,
  }, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  let lyrics = resp.data.choices?.[0]?.message?.content?.trim();
  if (!lyrics) throw new Error('GPT nao retornou letra editada.');
  lyrics = stripStructureLabels(lyrics);
  console.log(`[GPT] ✅ Letra editada (${lyrics.length} chars)`);
  return lyrics;
}

// ═══ VERIFICAÇÃO PÓS-GERAÇÃO (10/ago/2026) ═══
// Editor que revisa a letra JÁ pronta contra a história e CORRIGE só o que está
// errado (correção cirúrgica; NUNCA reescreve do zero — senão degrada letra boa).
// Checklist vem da análise de 300 letras. Roda no A/B: mini (B) ou 4o (C).
const LYRICS_VERIFY_SYSTEM_PROMPT = `Você é um REVISOR/EDITOR de letras de música personalizadas em português do Brasil. Recebe a HISTÓRIA enviada pelo cliente e a LETRA já composta. Corrija a letra APENAS onde houver problema, mantendo intacto tudo que já está bom.

REGRA DE OURO: mexa só no necessário. Se um verso está correto, NÃO o reescreva. Preserve a estrutura, as rimas, a métrica e o estilo da letra original. Nunca reescreva a letra do zero. Se a letra já estiver totalmente correta, devolva-a exatamente igual.

CORRIJA quando encontrar:
1. IDADE errada: toda idade citada tem que bater com a história (número exato; "vinte e dois" = 22). Se a letra troca a idade, conserte.
2. NOME errado ou inconsistente: o homenageado deve ser chamado sempre pelo nome certo. Se a letra usa outro nome, ou uma grafia diferente da que a HISTÓRIA usa, corrija para a grafia da história.
3. PALAVRA INVENTADA / VERSO ABSURDO: nenhuma palavra pode ser inexistente em português (ex.: "destilha", "murilho", "arrugo", "festo") e nenhum verso pode ser absurdo (ex.: chamar o pai de "meu aprendiz"; o marido dizer "sou seu filho" para a esposa; "ouvir o seu véu"). Reescreva SÓ esse verso, mantendo rima e sentido.
4. PERSPECTIVA/GÊNERO do cantor: a concordância tem que ser consistente. Mulher cantando usa feminino ("grata", "sozinha"); homem usa masculino. Corrija trocas (ex.: mãe cantando "Grato", esposa chamada de "rei").
5. CONOTAÇÃO NEGATIVA: o homenageado nunca pode ser chamado de "cruz", "fardo", "sina", "açoite" ou "peso", nem com metáfora de sofrimento/obrigação. Corrija.
6. ESTILO: se o estilo é religioso (Gospel), a letra deve ter fé — MAS a adoração é a Deus, jamais ao homenageado (não aponte "a Ti eu louvo" para a pessoa). Corrija os dois lados.
7. FATO INVENTADO: não pode haver fato, ocasião, briga, término, distância ou personagem que NÃO esteja na história (ex.: inventar "aniversário", inventar um término, trocar "Patrulha Canina" por "Patrick"). Remova ou ajuste.
8. RELAÇÃO trocada: mantenha a relação da história (afilhada não vira filha; irmão não vira "amigo").
9. ERRO ÓBVIO DA HISTÓRIA: se há um typo evidente que mudou o sentido (ex.: "passa alergia" quando é "alegria"), use o sentido correto.
10. TATO: informação íntima/sensível (motel, presídio, doença crua) deve ser tratada com delicadeza ou omitida.
11. FRAQUEZA: não deixe hesitação que enfraqueça a mensagem ("talvez", "só um momento") numa declaração de amor.

SAÍDA: devolva SOMENTE a letra final (corrigida ou igual). Sem rótulos, sem emojis, sem explicar o que mudou, sem comentários.`;

// Revisa+corrige uma letra recém-gerada. model: 'gpt-4o-mini' (B) ou 'gpt-4o' (C).
// Retorna a letra revisada; em qualquer erro, LANÇA (o chamador faz fallback pra original).
async function verifyAndFixLyrics(lyrics, story, { honoreeName, relationship, occasion, genre, mood, voice } = {}, { model = 'gpt-4o-mini' } = {}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY nao configurado.');
  if (!lyrics || !String(lyrics).trim()) throw new Error('letra vazia.');

  const ctx = [];
  if (honoreeName) ctx.push(`Nome do homenageado: ${honoreeName}`);
  if (relationship) ctx.push(`Relação: ${relationship}`);
  if (occasion) ctx.push(`Ocasião: ${occasion}`);
  if (genre) ctx.push(`Estilo musical: ${genre}`);
  if (mood) ctx.push(`Tom/Clima: ${mood}`);
  if (voice === 'Masculino') ctx.push('Perspectiva: ele cantando');
  if (voice === 'Feminino') ctx.push('Perspectiva: ela cantando');

  const userPrompt = `${ctx.join('\n')}\n\nHISTÓRIA:\n${story || '(sem história)'}\n\nLETRA A REVISAR:\n${String(lyrics).trim()}\n\nDevolva a letra revisada (só a letra).`;

  console.log(`[GPT-verify] revisando letra com ${model}...`);
  const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
    model,
    messages: [
      { role: 'system', content: LYRICS_VERIFY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3, // baixa: queremos correção conservadora, não criatividade
    max_tokens: 2000,
  }, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 40000,
  });
  let out = resp.data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('verify nao retornou letra.');
  out = stripStructureLabels(out);
  const changed = out.trim() !== String(lyrics).trim();
  console.log(`[GPT-verify] ✅ (${model}) ${changed ? 'CORRIGIU' : 'sem mudança'} (${out.length} chars)`);
  return { lyrics: out, changed };
}

module.exports = { generateLyricsWithGPT, editLyricsWithGPT, verifyAndFixLyrics, LYRICS_SYSTEM_PROMPT, LYRICS_SYSTEM_PROMPT_V2 };
