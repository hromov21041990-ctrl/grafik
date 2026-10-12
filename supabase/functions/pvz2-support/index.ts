import { sendSupportNotification } from "./telegram.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
const url=Deno.env.get("SUPABASE_URL")||"";
const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const db=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
const publishable="sb_publishable_eIWwXJEBGxYAbnhOc-MKfw_NitfQtB_";
const origins=new Set(["https://hromov21041990-ctrl.github.io","https://grafik.hromov-aa.chatgpt.site","https://po-grafiku.ru"]);
function reply(origin:string,status:number,result:Record<string,unknown>){
 return new Response(JSON.stringify(result),{status,headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":origin,"access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"POST,OPTIONS","cache-control":"no-store"}});
}
async function sha256(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,"0")).join("")}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin")||"";
 if(!origins.has(origin))return reply(origin,403,{error:"Недоступный источник"});
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"access-control-allow-origin":origin,"access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"POST,OPTIONS"}});
 if(req.method!=="POST")return reply(origin,405,{error:"Метод не поддерживается"});
 if(req.headers.get("apikey")!==publishable)return reply(origin,401,{error:"Неверный ключ приложения"});
 try{
  const raw=await req.text();
  if(raw.length>14000)return reply(origin,413,{error:"Слишком большое сообщение"});
  const v=JSON.parse(raw);
  if(!v||typeof v!=="object"||Array.isArray(v)||v.action!=="supportSubmit")return reply(origin,400,{error:"Неизвестное действие"});
  const category=v.category;
  const title=typeof v.title==="string"?v.title.trim():"";
  const message=typeof v.message==="string"?v.message.trim():"";
  const contact=typeof v.email==="string"?v.email.trim().toLowerCase():"";
  const contextCode=typeof v.pointCode==="string"?v.pointCode.trim().toLowerCase():"";
  if(!["bug","question","idea","access"].includes(category)||title.length<4||title.length>120||message.length<15||message.length>4000||contact.length>200||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))
   return reply(origin,400,{error:"Заполните тему (4–120 знаков), описание (15–4000 знаков) и действующий email"});
  if(contextCode&&!/^[a-z0-9-]{4,32}$/.test(contextCode))return reply(origin,400,{error:"Код точки укажите латиницей или оставьте пустым"});
  if(v.website)return reply(origin,200,{ok:true,message:"Обращение принято"});
  const bearer=req.headers.get("authorization")||"";
  let companyId:string|null=null,ownerUid:string|null=null,companyCode=contextCode,role="guest";
  if(bearer){
   if(!bearer.startsWith("Bearer ")||bearer.length>150)return reply(origin,401,{error:"Сессия истекла. Войдите снова или отправьте обращение со страницы входа."});
   const hash=await sha256(bearer.slice(7));
   const {data:s,error:se}=await db.from("pvz2_sessions").select("company_id,role").eq("token_hash",hash).gt("expires_at",new Date().toISOString()).maybeSingle();
   if(se||!s)return reply(origin,401,{error:"Сессия истекла. Войдите снова или отправьте обращение со страницы входа."});
   const {data:c}=await db.from("pvz2_companies").select("code,owner_auth_uid").eq("id",s.company_id).maybeSingle();
   if(!c)return reply(origin,401,{error:"Точка не найдена. Войдите снова."});
   companyId=s.company_id;companyCode=c.code;ownerUid=s.role==="owner"?c.owner_auth_uid:null;role=s.role==="owner"?"owner":"staff";
  }
  const ip=(req.headers.get("cf-connecting-ip")||req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"unknown").slice(0,100);
  const ipHash=await sha256(ip+":"+serviceKey.slice(0,40));
  const now=Date.now(),start=new Date(now).toISOString();
  const {data:rate,error:rateErr}=await db.from("pvz2_support_rate_limits").select("window_started,attempts").eq("ip_hash",ipHash).maybeSingle();
  if(rateErr)return reply(origin,503,{error:"Поддержка временно недоступна. Повторите позже."});
  const oldStart=rate?Date.parse(rate.window_started):0;
  const within=Number.isFinite(oldStart)&&now-oldStart<3600000;
  const attempts=within?Number(rate.attempts)+1:1;
  if(attempts>5)return reply(origin,429,{error:"За час уже отправлено 5 обращений. Попробуйте позже."});
  const saveRate=await db.from("pvz2_support_rate_limits").upsert({ip_hash:ipHash,window_started:within?rate.window_started:start,attempts},{onConflict:"ip_hash"});
  if(saveRate.error)return reply(origin,503,{error:"Поддержка временно недоступна. Повторите позже."});
  const {data:ticket,error}=await db.from("pvz2_support_tickets").insert({company_id:companyId,owner_auth_uid:ownerUid,company_code:companyCode,category,title,message,contact_email:contact,sender_role:role}).select("id,category,title,message,contact_email,company_code,sender_role,created_at").single();
  if(error||!ticket)return reply(origin,503,{error:"Не удалось отправить обращение. Попробуйте ещё раз."});
  // The ticket is committed before any Telegram work. Notification failure never rejects it.
  try {
   const delivery=await sendSupportNotification(ticket,{
    token:Deno.env.get("TELEGRAM_BOT_TOKEN"),
    chatId:Deno.env.get("TELEGRAM_CHAT_ID"),
   });
   const {error:markError}=await db.from("pvz2_support_tickets").update({
    telegram_notified_at:delivery.notifiedAt,
    telegram_delivery_error:delivery.error,
   }).eq("id",ticket.id).abortSignal(AbortSignal.timeout(5000));
   if(markError)console.error("support_telegram_delivery_marker_failed",ticket.id);
  }catch{console.error("support_telegram_delivery_marker_failed",ticket.id)}
  return reply(origin,200,{ok:true,ticketId:ticket.id});
 }catch{return reply(origin,400,{error:"Не удалось обработать обращение. Проверьте данные."})}
});