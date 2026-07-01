const fs=require('fs'),axios=require('axios');
const env=fs.readFileSync('C:/Users/charl/Downloads/.env.cancao_de_presente','utf8');
const get=k=>(env.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1];
const SUPA=get('SUPABASE_URL'),KEY=get('SUPABASE_KEY');
const API=(get('SUNO_API_BASE')||'https://suno-api.bvph.uk').trim();
const H={apikey:KEY,Authorization:'Bearer '+KEY};
const ORDER='49dcdd8d-3f54-41e9-a6fa-e5f5a26c8463';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const o=(await axios.get(SUPA+`/orders?id=eq.${ORDER}&select=*`,{headers:H})).data[0];
 console.log('Pedido:',o.honoree_name,'| status:',o.status,'| genre:',o.genre,'| voice:',o.voice_preference);
 // monta tags (igual regenerate)
 const v=o.voice_preference||'';const parts=[];
 if(o.genre)parts.push(o.genre); if(o.mood)parts.push(o.mood);
 if(/feminin|female|mulher/i.test(v))parts.push('female vocals'); else if(/masculin|male|homem/i.test(v))parts.push('male vocals');
 const tags=parts.join(', ');
 // PAYLOAD SEM PHONE → webhook de notificacao da cliente NAO dispara (generateSong.js:632)
 const payload={orderId:ORDER,story:o.story,title:'Para '+o.honoree_name,honoreeName:o.honoree_name,relationship:o.relationship||'',genre:o.genre||'',mood:o.mood||'',voice:v,tags};
 console.log('tags:',tags,'| (sem phone → sem notificação)');
 const r=await axios.post(`${API}/api/generate_and_notify`,payload,{headers:{'Content-Type':'application/json'},timeout:30000});
 console.log('dispatch:',JSON.stringify(r.data));
 // poll o pedido até ter audio
 for(let i=0;i<36;i++){
   await sleep(20000);
   const c=(await axios.get(SUPA+`/orders?id=eq.${ORDER}&select=status,full_audio_urls,original_audio_url,error_message`,{headers:H})).data[0];
   const n=Array.isArray(c.full_audio_urls)?c.full_audio_urls.length:0;
   process.stdout.write(`[${i}] status=${c.status} full=${n} `);
   if(n>=1||c.original_audio_url){console.log('\n✅ AUDIO PRONTO');console.log('full:',JSON.stringify(c.full_audio_urls));console.log('orig:',c.original_audio_url);break;}
   if(c.error_message&&/falh|error|erro/i.test(c.error_message)){console.log('\n⚠ erro:',c.error_message);}
 }
})().catch(e=>console.error('ERR',e.response?.status,e.message,JSON.stringify(e.response?.data||'').slice(0,200)));
