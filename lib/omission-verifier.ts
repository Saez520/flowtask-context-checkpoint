const delays=[0,150,500]
export type Verification = {kind:"tag"}|{kind:"omission"}|{kind:"unknown"}
export interface VerifyOptions { sessionID:string; messageID:string; signal:AbortSignal; read:()=>Promise<readonly {id:string;type:string;content?:readonly {type:string;text?:string}[]}[]>; log:()=>void }
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);const t=setTimeout(resolve,ms);signal.addEventListener("abort",()=>{clearTimeout(t);reject(signal.reason)},{once:true})})
async function timed<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return Promise.race([promise,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error("timeout")),1000);signal.addEventListener("abort",()=>{clearTimeout(t);reject(signal.reason)},{once:true})})])}
export async function verifyOmission(options:VerifyOptions):Promise<Verification>{
 let logged=false
 for(const delay of delays){try{await wait(delay,options.signal);const items=await timed(options.read(),options.signal);const item=items.find(x=>x.id===options.messageID);if(!item||item.type!=="assistant")continue;const text=item.content?.filter(p=>p.type==="text").map(p=>p.text??"").join("\n")??"";return text.includes("[FLOWTASK_CHECKPOINT_CAPACITY:")?{kind:"tag"}:{kind:"omission"}}catch{if(options.signal.aborted)break}}
 if(!logged){logged=true;options.log()}return {kind:"unknown"}
}
