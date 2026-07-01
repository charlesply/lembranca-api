import fs from 'fs'; import axios from 'axios'; import path from 'path';
const env=fs.readFileSync('C:/Users/charl/Downloads/.env.cancao_de_presente','utf8');
const get=k=>(env.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1];
const SUPA=get('SUPABASE_URL'),KEY=get('SUPABASE_KEY');
const API='https://suno-api-novo.bvph.uk';
const H={apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'};
const ORDER='dda9f0b1-a6e7-4b01-89f7-d7cfffc6b37c';
const S=ms=>new Promise(r=>setTimeout(r,ms));
const LYRICS=`[Verse 1]
Quando te peguei no colo, eu prometi te proteger
Hoje vejo uma mulher onde eu vi um bebê crescer
Quinze anos, meu amor, e que orgulho de te ver
Minha menina valente, que aprendeu a florescer

[Pre-Chorus]
Fui teu pai e tua mãe, segurei a tua mão
E a cada passo teu, dispara meu coração

[Chorus]
Kamila, minha princesa, minha estrela a brilhar
A tua força me ensina, teu sorriso é meu lar
Cresce sem ter medo, que eu seguro o teu chão
Você é o maior amor da minha vida, meu coração

[Verse 2]
Da menina bailarina à quadra onde você vibra
Tem garra no teu jeito e doçura em cada linha
Timidez que esconde um fogo, uma alma que cativa
Por onde você passa, o mundo todo se ilumina

[Pre-Chorus]
Pode sonhar bem alto que eu não solto a tua mão
Voa, minha filha, que eu sou o teu chão

[Chorus]
Kamila, minha princesa, minha estrela a brilhar
A tua força me ensina, teu sorriso é meu lar
Cresce sem ter medo, que eu seguro o teu chão
Você é o maior amor da minha vida, meu coração

[Bridge]
E quando a rubro-negra paixão te fizer cantar
Eu vou tá na torcida do teu sonho, a te amar

[Chorus]
Kamila, minha princesa, pra sempre vou cuidar
Do meu maior tesouro, da razão do meu olhar`;
const patch=(b)=>axios.patch(SUPA+`/orders?id=eq.${ORDER}`,b,{headers:H});
(async()=>{
 const o0=(await axios.get(SUPA+`/orders?id=eq.${ORDER}&select=status,full_audio_urls`,{headers:H})).data[0];
 const old=o0.full_audio_urls?.[0]||null;
 console.log('antes:',o0.status);
 await patch({status:'generating'});
 const r=await axios.post(`${API}/api/generate_and_notify`,{orderId:ORDER,prompt:LYRICS,story:'',title:'Para Kamila',honoreeName:'Kamila',genre:'Sertanejo',mood:'Romântico',voice:'Feminino',tags:'Sertanejo, Romântico, female vocals'},{headers:{'Content-Type':'application/json'},timeout:30000});
 console.log('dispatch:',JSON.stringify(r.data));
 let f=null;
 for(let i=0;i<18;i++){await S(20000);
   const c=(await axios.get(SUPA+`/orders?id=eq.${ORDER}&select=status,full_audio_urls`,{headers:H})).data[0];
   const a=c.full_audio_urls||[];process.stdout.write(`[${i}]${c.status} n=${a.length} `);
   if(a.length&&a[0]!==old){f=a;break;}}
 await patch({status:'paid',final_lyrics:LYRICS});
 if(!f){console.log('\nsem audio novo no tempo — status=paid restaurado, conferir.');process.exit(0);}
 console.log('\nNOVO:',JSON.stringify(f));
 const dir='C:/Users/charl/Downloads/entregas/Marlucia_Kamila_4568';fs.mkdirSync(dir,{recursive:true});
 let i=1;for(const u of f){const d=await axios.get(u,{responseType:'arraybuffer',timeout:60000});fs.writeFileSync(path.join(dir,`Kamila - Versao ${i}.mp3`),d.data);console.log('baixou v'+i,(d.data.length/1024).toFixed(0)+'KB');i++;}
})().catch(async e=>{console.error('ERR',e.response?.status,e.message);try{await axios.patch(SUPA+`/orders?id=eq.${ORDER}`,{status:'paid'},{headers:H});}catch(_){}});
