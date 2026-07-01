import fs from 'fs'; import axios from 'axios';
const env=fs.readFileSync('C:/Users/charl/Downloads/.env.cancao_de_presente','utf8');
const get=k=>(env.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1];
const SUPA=get('SUPABASE_URL'),KEY=get('SUPABASE_KEY');
const API='https://suno-api-novo.bvph.uk';
const H={apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'};
const ORDER='dda9f0b1-a6e7-4b01-89f7-d7cfffc6b37c';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
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
const patch=(p,b)=>axios.patch(SUPA+p,b,{headers:H});
(async()=>{
 const o0=(await axios.get(SUPA+`/orders?id=eq.${ORDER}&select=status,full_audio_urls`,{headers:H})).data[0];
 const oldFirst=Array.isArray(o0.full_audio_urls)?o0.full_audio_urls[0]:null;
 console.log('status antes:',o0.status,'| old[0]:',oldFirst);
 if(o0.status!=='paid'){console.log('⚠ status inesperado, abortando p/ segurança');process.exit(1);}
 await patch(`/orders?id=eq.${ORDER}`,{status:'generating'});
 console.log('status→generating (libera trava). SEM phone = sem envio automático.');
 const payload={orderId:ORDER,prompt:LYRICS,story:'',title:'Para Kamila',honoreeName:'Kamila',relationship:'Filho(a)',genre:'Sertanejo',mood:'Romântico',voice:'Feminino',tags:'Sertanejo, Romântico, female vocals'};
 const r=await axios.post(`${API}/api/generate_and_notify`,payload,{headers:{'Content-Type':'application/json'},timeout:30000});
 console.log('dispatch:',JSON.stringify(r.data));
 let novo=null;
 for(let i=0;i<40;i++){
   await sleep(20000);
   const c=(await axios.get(SUPA+`/orders?id=eq.${ORDER}&select=status,full_audio_urls,final_lyrics`,{headers:H})).data[0];
   const f=Array.isArray(c.full_audio_urls)?c.full_audio_urls:[];
   process.stdout.write(`[${i}] ${c.status} n=${f.length} `);
   if(f.length>=1 && f[0]!==oldFirst){novo=f;console.log('\n✅ NOVO AUDIO:',JSON.stringify(f));
     // restaura paid imediatamente + garante letra nova
     await patch(`/orders?id=eq.${ORDER}`,{status:'paid',final_lyrics:LYRICS});
     console.log('status→paid restaurado, letra nova gravada.');
     const chk=(await axios.get(SUPA+`/orders?id=eq.${ORDER}&select=final_lyrics`,{headers:H})).data[0];
     console.log('letra confere com a minha?', (chk.final_lyrics||'').includes('minha princesa, minha estrela'));
     break;}
 }
 if(!novo){await patch(`/orders?id=eq.${ORDER}`,{status:'paid'});console.log('⚠ audio não trocou no tempo do poll; status restaurado=paid. Checar depois.');process.exit(0);}
 console.log('URLS_NOVAS='+JSON.stringify(novo));
})().catch(async e=>{console.error('ERR',e.response?.status,e.message,JSON.stringify(e.response?.data||'').slice(0,160));
 try{await axios.patch(SUPA+`/orders?id=eq.${ORDER}`,{status:'paid'},{headers:H});console.error('(status restaurado=paid no catch)');}catch(_){}});
