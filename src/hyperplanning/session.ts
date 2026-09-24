import { createCipheriv, createHash, randomBytes } from "node:crypto";

export interface HyperplanningSession { baseUrl:string; sessionId:number; iv:Buffer; nextOrder:number }
export interface HyperplanningStartParams { sessionId:number; genreEspace:number; genreAcces?:number; genreOnglet?:string; numeroRessource?:number; libelleRecherche?:string }

export async function createHyperplanningSession(inviteUrl:string, timeoutMs:number):Promise<HyperplanningSession & {start:HyperplanningStartParams}>{
  const res=await fetch(inviteUrl,{signal:AbortSignal.timeout(timeoutMs),headers:{"user-agent":"study-scheduler/1.0"}});
  if(!res.ok) throw new Error(`Hyperplanning invite failed: HTTP ${res.status}`);
  const html=await res.text();
  const m=/Start\s*\(\s*\{([^}]*)\}\s*\)/.exec(html);
  if(!m) throw new Error("Hyperplanning invite did not contain a Start(...) session initializer");
  const fields=new Map<string,string>();
  for(const part of m[1].split(",")){const x=/\s*([A-Za-z_$][\w$]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+)|([^,]+))\s*/.exec(part);if(x)fields.set(x[1],x[2]??x[3]??x[4]??x[5]??"");}
  const sessionId=Number(fields.get("i")); if(!Number.isSafeInteger(sessionId)||sessionId<=0)throw new Error("Hyperplanning invite returned an invalid session id");
  return {baseUrl:inviteUrl.replace(/\/invite(?:[?#].*)?$/,""),sessionId,iv:randomBytes(16),nextOrder:1,start:{sessionId,genreEspace:Number(fields.get("a")??2),genreAcces:fields.has("b")?Number(fields.get("b")):undefined,genreOnglet:fields.get("c"),numeroRessource:fields.has("e")?Number(fields.get("e")):undefined,libelleRecherche:fields.get("h")}};
}

function encryptOrder(order:number,iv:Buffer){const key=createHash("md5").update(Buffer.alloc(0)).digest();const aesIv=iv.length?createHash("md5").update(iv).digest():Buffer.alloc(16);const cipher=createCipheriv("aes-128-cbc",key,aesIv);return Buffer.concat([cipher.update(String(order),"utf8"),cipher.final()]).toString("hex");}

export async function hyperplanningRequest<T>(session:HyperplanningSession,functionName:string,dataSec:unknown,timeoutMs:number):Promise<T>{
  const order=session.nextOrder, encryptedOrder=encryptOrder(order,order===1?Buffer.alloc(0):session.iv);
  const res=await fetch(`${session.baseUrl}/appelfonction/2/${session.sessionId}/${encryptedOrder}`,{method:"POST",signal:AbortSignal.timeout(timeoutMs),headers:{"content-type":"application/json",origin:session.baseUrl,referer:`${session.baseUrl}/invite`,"user-agent":"study-scheduler/1.0"},body:JSON.stringify({session:session.sessionId,no:encryptedOrder,id:functionName,dataSec})});
  if(!res.ok)throw new Error(`Hyperplanning ${functionName} failed: HTTP ${res.status}`);
  const json=await res.json() as Record<string,unknown>;
  if(json.Erreur)throw new Error(`Hyperplanning ${functionName}: server returned an error`);
  if(json.id!==functionName)throw new Error(`Hyperplanning ${functionName}: unexpected response id`);
  if(!json.dataSec||typeof json.dataSec!=="object")throw new Error(`Hyperplanning ${functionName}: missing dataSec response`);
  session.nextOrder+=2; return (json.dataSec as Record<string,unknown>).data as T;
}

export async function fetchHyperplanningParameters(session:HyperplanningSession,start:HyperplanningStartParams,timeoutMs:number){
  const data=await hyperplanningRequest<Record<string,unknown>>(session,"FonctionParametres",{data:{ModeJeton:false,Uuid:session.iv.toString("base64"),identifiantNav:""}},timeoutMs);
  const p=data?.parametreGeneral as Record<string,unknown>|undefined;
  const a=valueOfTypedDate(p?.PremierLundi),b=valueOfTypedDate(p?.DerniereDate),n=Number(p?.PlacesParJour);
  if(!a||!b||!Number.isInteger(n)||n<=0)throw new Error("Hyperplanning parameters did not contain the academic period/grid");
  return {premierLundi:frenchDateToIso(a),derniereDate:frenchDateToIso(b),placesParJour:n};
}
function valueOfTypedDate(v:unknown){if(typeof v==="string")return v;if(typeof v==="object"&&v!==null&&typeof(v as Record<string,unknown>).V==="string")return(v as Record<string,string>).V;return null}
function frenchDateToIso(v:string){const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());if(!m)throw new Error(`Invalid Hyperplanning date: ${v}`);return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`}
