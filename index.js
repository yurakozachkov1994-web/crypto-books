const OWNER_WALLET = "UQDmF28UYpQ9vcrdq_2Macit_ZEh53pi26YG2QAHQFPyytOh";
const TON_API = "https://toncenter.com/api/v3";
const GRAM_NANO = 1000000000n;

const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json",...cors}});
const cors={"access-control-allow-origin":"*","access-control-allow-headers":"content-type,x-telegram-init-data","access-control-allow-methods":"GET,POST,OPTIONS"};

async function hmac(key,data){return crypto.subtle.importKey("raw",key,{name:"HMAC",hash:"SHA-256"},false,["sign"])}
function hex(a){return [...new Uint8Array(a)].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function validateInitData(initData,botToken){
  if(!initData) throw new Error("Telegram initData отсутствует");
  const p=new URLSearchParams(initData), hash=p.get("hash"); if(!hash) throw new Error("Некорректный initData");
  p.delete("hash"); const dataCheck=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n");
  const secret=await hmac(new TextEncoder().encode("WebAppData"),new TextEncoder().encode(botToken));
  const sk=await crypto.subtle.sign("HMAC",secret,new TextEncoder().encode(botToken));
  const k=await hmac(new Uint8Array(sk),new TextEncoder().encode(dataCheck));
  const sig=await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(dataCheck));
  if(hex(sig)!==hash) throw new Error("Недействительный Telegram initData");
  const u=JSON.parse(p.get("user")||"{}"); return {id:u.id,name:[u.first_name,u.last_name].filter(Boolean).join(" ")||"Игрок",start_param:p.get("start_param")||""};
}
async function db(env,q,...a){return env.DB.prepare(q).bind(...a).all()}
async function one(env,q,...a){return env.DB.prepare(q).bind(...a).first()}
async function run(env,q,...a){return env.DB.prepare(q).bind(...a).run()}
function uid(){return crypto.randomUUID()}

function toNano(value){
  const s=String(value).trim();
  if(!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error("Некорректная сумма");
  const [whole,frac=""] = s.split(".");
  return BigInt(whole)*GRAM_NANO + BigInt((frac+"000000000").slice(0,9));
}
function fromNano(n){return (Number(n)/1e9).toFixed(3)}
function base64ToBytes(b64){
  const bin=atob(b64.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(b64.length/4)*4,"="));
  return Uint8Array.from(bin,c=>c.charCodeAt(0));
}
function readUint(bytes,pos,n){let v=0;for(let i=0;i<n;i++)v=v*256+bytes[pos+i];return v}
function decodeCommentBody(b64){
  try{
    const b=base64ToBytes(b64); if(b.length<8) return null;
    const magic=readUint(b,0,4); if(magic!==0xb5ee9c72) return null;
    const flags=b[4], hasIdx=(flags&0x80)!==0, hasCrc=(flags&0x40)!==0, sizeBytes=flags&7, offBytes=b[5];
    let p=6;
    const cells=readUint(b,p,sizeBytes); p+=sizeBytes;
    const roots=readUint(b,p,sizeBytes); p+=sizeBytes;
    const absent=readUint(b,p,sizeBytes); p+=sizeBytes;
    const total=readUint(b,p,offBytes); p+=offBytes;
    if(cells<1||roots<1||absent!==0) return null;
    if(hasIdx) p+=cells*offBytes;
    p+=roots*sizeBytes;
    const d1=b[p++], d2=b[p++];
    if((d1&7)!==0) return null;
    const dataBytes=Math.ceil(d2/2); if(p+dataBytes>b.length) return null;
    if(d2%2!==0) return null; // our comment payload is byte-aligned
    const data=b.slice(p,p+dataBytes);
    if(data.length<4 || data[0]||data[1]||data[2]||data[3]) return null;
    return new TextDecoder().decode(data.slice(4)).replace(/\u0000+$/g,"");
  }catch{return null}
}
async function telegramMember(env,chat,userId){
  const r=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${userId}`);
  const j=await r.json(); if(!j.ok) return false;
  return ["member","administrator","creator"].includes(j.result?.status);
}
async function user(env,init){
  const u=await validateInitData(init,env.BOT_TOKEN);
  let row=await one(env,"SELECT * FROM users WHERE id=?",u.id);
  if(!row){
    let ref=null;
    if(u.start_param.startsWith("ref_")){const x=Number(u.start_param.slice(4));if(x&&x!==u.id&&await one(env,"SELECT id FROM users WHERE id=?",x))ref=x}
    await run(env,"INSERT INTO users(id,name,referrer_id) VALUES(?,?,?)",u.id,u.name,ref);
    row=await one(env,"SELECT * FROM users WHERE id=?",u.id);
  }
  return {tg:u,row};
}
async function admin(env,id){if(Number(id)!==Number(env.ADMIN_ID)) throw new Error("Нет доступа")}

async function tonFetch(env,path,params={}){
  const u=new URL(TON_API+path);
  for(const [k,v] of Object.entries(params)) if(v!==undefined&&v!==null) u.searchParams.append(k,String(v));
  const headers={"accept":"application/json"}; if(env.TONCENTER_API_KEY) headers["X-API-Key"]=env.TONCENTER_API_KEY;
  const r=await fetch(u,{headers});
  const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error||`TON API ${r.status}`);
  return j;
}

async function findMatchingPayment(env,deposit){
  const now=Math.floor(Date.now()/1000);
  const start=Math.max(0,now-86400);
  const j=await tonFetch(env,"/transactions",{account:OWNER_WALLET,limit:100,sort:"desc",start_utime:start});
  for(const tx of (j.transactions||[])){
    const m=tx.in_msg;
    if(!m || m.destination!==tx.account || m.bounced===true) continue;
    if(!m.value || BigInt(m.value)!==BigInt(deposit.amount_nano)) continue;
    const comment=decodeCommentBody(m.message_content?.body||"");
    if(comment!==deposit.reference) continue;
    return {txHash:tx.hash,messageHash:m.hash,source:m.source||null,lt:tx.lt,mcBlockSeqno:tx.mc_block_seqno};
  }
  return null;
}

async function confirmDeposit(env,deposit){
  if(deposit.status!=="pending") return false;
  const payment=await findMatchingPayment(env,deposit); if(!payment) return false;
  const existing=await one(env,"SELECT id FROM deposits WHERE tx_hash=? AND status='confirmed'",payment.txHash);
  if(existing && existing.id!==deposit.id) throw new Error("Эта транзакция уже была зачислена");
  const changed=await run(env,"UPDATE deposits SET status='confirmed',tx_hash=?,message_hash=?,sender_address=?,confirmed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND tx_hash IS NULL",payment.txHash,payment.messageHash,payment.source,deposit.id);
  if(!changed.meta?.changes) return false;
  await run(env,"UPDATE users SET balance=balance+? WHERE id=?",deposit.amount,deposit.user_id);
  const u=await one(env,"SELECT referrer_id FROM users WHERE id=?",deposit.user_id);
  if(u?.referrer_id){
    const c=deposit.amount*0.10;
    await run(env,"UPDATE users SET balance=balance+? WHERE id=?",c,u.referrer_id);
    await run(env,"INSERT INTO referral_ledger(id,referrer_id,user_id,source,base_amount,commission) VALUES(?,?,?,?,?,?)",uid(),u.referrer_id,deposit.user_id,"deposit",deposit.amount,c);
  }
  return true;
}

async function syncPending(env){
  const pending=(await db(env,"SELECT * FROM deposits WHERE status='pending' ORDER BY created_at ASC LIMIT 25")).results;
  let confirmed=0;
  for(const d of pending){try{if(await confirmDeposit(env,d)) confirmed++}catch(e){console.error("deposit",d.id,e.message)}}
  return confirmed;
}

export default {
 async scheduled(_event,env,ctx){ctx.waitUntil(syncPending(env));},
 async fetch(req,env){
  if(req.method==="OPTIONS") return new Response("",{status:204,headers:cors});
  try{
   const path=new URL(req.url).pathname, init=req.headers.get("X-Telegram-Init-Data");
   const {tg,row}=await user(env,init);
   if(path==="/api/bootstrap"){
     await syncPending(env);
     const tasks=(await db(env,"SELECT id,title,type,url,reward FROM tasks WHERE active=1 ORDER BY created_at DESC")).results;
     const refs=await db(env,"SELECT source,base_amount,commission,created_at FROM referral_ledger WHERE referrer_id=? ORDER BY created_at DESC LIMIT 30",tg.id);
     const count=await one(env,"SELECT COUNT(*) c FROM users WHERE referrer_id=?",tg.id);
     const deposits=await db(env,"SELECT id,amount,status,reference,tx_hash,created_at,confirmed_at FROM deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 10",tg.id);
     let adm=null;
     if(Number(tg.id)===Number(env.ADMIN_ID)){
       const a=await Promise.all([
        one(env,"SELECT COUNT(*) c FROM users"),one(env,"SELECT COUNT(*) c FROM tasks WHERE active=1"),one(env,"SELECT COUNT(*) c FROM withdrawals WHERE status='pending'"),
        db(env,"SELECT w.id,w.amount,w.address,u.name user_name FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status='pending' ORDER BY w.created_at DESC"),
        db(env,"SELECT d.id,d.amount,d.status,d.reference,d.tx_hash,u.name user_name FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.status='pending' ORDER BY d.created_at DESC"),
        db(env,"SELECT id,name,balance FROM users ORDER BY created_at DESC LIMIT 50")
       ]);
       adm={users:a[0].c,tasks:a[1].c,withdrawals:a[2].c,withdrawal_items:a[3].results,deposit_items:a[4].results,user_items:a[5].results};
     }
     return json({user:row,tasks,ref:{count:count.c,link:`https://t.me/${env.BOT_USERNAME}?startapp=ref_${tg.id}`,history:refs.results},deposits:deposits.results,deposit_address:OWNER_WALLET,admin:adm});
   }
   if(path==="/api/tasks/start"&&req.method==="POST"){
     const b=await req.json(),t=await one(env,"SELECT * FROM tasks WHERE id=? AND active=1",b.task_id);if(!t)throw new Error("Задание не найдено");
     const done=await one(env,"SELECT 1 x FROM task_completions WHERE user_id=? AND task_id=?",tg.id,t.id);if(done)throw new Error("Задание уже выполнено");
     return json({url:t.url,message:"Откройте задание, выполните его и вернитесь для проверки."});
   }
   if(path==="/api/tasks/complete"&&req.method==="POST"){
     const b=await req.json(),t=await one(env,"SELECT * FROM tasks WHERE id=? AND active=1",b.task_id);if(!t)throw new Error("Задание не найдено");
     if(await one(env,"SELECT 1 x FROM task_completions WHERE user_id=? AND task_id=?",tg.id,t.id))throw new Error("Уже засчитано");
     if(!(await telegramMember(env,t.chat_username,tg.id)))throw new Error("Подписка/участие не подтверждены. Проверьте, что вы выполнили задание.");
     await run(env,"INSERT INTO task_completions(user_id,task_id,reward) VALUES(?,?,?)",tg.id,t.id,t.reward);
     await run(env,"UPDATE users SET balance=balance+?,completed_tasks=completed_tasks+1 WHERE id=?",t.reward,tg.id);
     const u=await one(env,"SELECT referrer_id FROM users WHERE id=?",tg.id);
     if(u?.referrer_id){const c=t.reward*0.15;await run(env,"UPDATE users SET balance=balance+? WHERE id=?",c,u.referrer_id);await run(env,"INSERT INTO referral_ledger(id,referrer_id,user_id,source,base_amount,commission) VALUES(?,?,?,?,?,?)",uid(),u.referrer_id,tg.id,"task",t.reward,c)}
     return json({message:`Задание подтверждено. +${t.reward.toFixed(3)} GRAM`});
   }
   if(path==="/api/ads/reward"&&req.method==="POST"){
     const last=row.last_ad_at?Date.parse(row.last_ad_at):0;if(Date.now()-last<60000)throw new Error("Подождите перед следующим просмотром");
     const reward=0.005;await run(env,"UPDATE users SET balance=balance+?,last_ad_at=CURRENT_TIMESTAMP WHERE id=?",reward,tg.id);
     return json({message:`Реклама просмотрена. +${reward.toFixed(3)} GRAM`});
   }
   if(path==="/api/deposits"&&req.method==="POST"){
     const b=await req.json();const nano=toNano(b.amount);if(nano<100000000n)throw new Error("Минимальное пополнение — 0.1 GRAM");
     const amount=Number(nano)/1e9,id=uid(),reference=`CF:${id.replace(/-/g,"").slice(0,20)}`;
     await run(env,"INSERT INTO deposits(id,user_id,amount,amount_nano,reference) VALUES(?,?,?,?,?)",id,tg.id,amount,nano.toString(),reference);
     return json({id,amount,amount_nano:nano.toString(),reference,address:OWNER_WALLET,message:"Заявка создана. Нажмите «Оплатить», отправьте точную сумму с указанным комментарием — зачисление произойдёт автоматически после подтверждения блокчейном."});
   }
   if(path.startsWith("/api/deposits/")&&path.endsWith("/status")&&req.method==="GET"){
     const id=path.split("/")[3],d=await one(env,"SELECT * FROM deposits WHERE id=? AND user_id=?",id,tg.id);if(!d)throw new Error("Пополнение не найдено");
     if(d.status==="pending") await confirmDeposit(env,d);
     const fresh=await one(env,"SELECT id,amount,status,reference,tx_hash,message_hash,created_at,confirmed_at FROM deposits WHERE id=?",id);
     return json(fresh);
   }
   if(path==="/api/withdrawals"&&req.method==="POST"){
     const b=await req.json(),amount=+b.amount;if(!Number.isFinite(amount)||amount<1||!b.address)throw new Error("Некорректные данные");
     if(row.balance<amount)throw new Error("Недостаточно средств");
     await run(env,"UPDATE users SET balance=balance-? WHERE id=?",amount,tg.id);
     const id=uid(),net=amount*0.95;await run(env,"INSERT INTO withdrawals(id,user_id,amount,net_amount,address) VALUES(?,?,?,?,?)",id,tg.id,amount,net,b.address);
     return json({message:`Заявка на вывод создана. К выплате ${net.toFixed(3)} GRAM`});
   }
   if(path==="/api/admin/tasks"&&req.method==="POST"){await admin(env,tg.id);const b=await req.json();if(!b.title||!b.chat_username||!b.url||+b.reward<=0)throw new Error("Заполните поля");await run(env,"INSERT INTO tasks(id,title,type,chat_username,url,reward,creator_id) VALUES(?,?,?,?,?,?,?)",uid(),b.title,b.type,b.chat_username,b.url,+b.reward,tg.id);return json({ok:true})}
   if(path.startsWith("/api/admin/deposits/")&&req.method==="POST"){
     await admin(env,tg.id);const id=path.split("/").pop(),b=await req.json();
     const d=await one(env,"SELECT * FROM deposits WHERE id=?",id);if(!d)throw new Error("Пополнение не найдено");
     if(d.status!=="pending")throw new Error("Уже обработано");
     if(b.status==="approved") throw new Error("Пополнения теперь подтверждаются только по блокчейну");
     await run(env,"UPDATE deposits SET status='rejected' WHERE id=?",id);return json({ok:true});
   }
   if(path.startsWith("/api/admin/withdrawals/")&&req.method==="POST"){await admin(env,tg.id);const id=path.split("/").pop(),b=await req.json(),w=await one(env,"SELECT * FROM withdrawals WHERE id=?",id);if(!w)throw new Error("Заявка не найдена");if(w.status!=="pending")throw new Error("Уже обработано");if(b.status==="approved"){await run(env,"UPDATE withdrawals SET status='approved' WHERE id=?",id)}else{await run(env,"UPDATE users SET balance=balance+? WHERE id=?",w.amount,w.user_id);await run(env,"UPDATE withdrawals SET status='rejected' WHERE id=?",id)}return json({ok:true})}
   return json({error:"Not found"},404);
  }catch(e){console.error(e);return json({error:e.message||"Ошибка сервера"},400)}
 }
}
