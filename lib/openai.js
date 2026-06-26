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

async function generateLyricsWithGPT(story, { honoreeName, relationship, occasion, genre, mood, voice }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY nao configurado.');

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

  const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LYRICS_SYSTEM_PROMPT },
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

module.exports = { generateLyricsWithGPT, LYRICS_SYSTEM_PROMPT };
