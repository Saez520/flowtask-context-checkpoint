import type { TokenUsage } from "./context-window"

export interface ResponseWindow { messageID?: string; text: string; ordinals: Set<string> }
interface Entry { child: boolean; usage?: TokenUsage; armed: boolean; window?: ResponseWindow; omissions: number; finished: string[]; epoch: number; tainted: boolean }

export class SessionState {
  private readonly entries = new Map<string, Entry>()
  private entry(id: string): Entry { let e=this.entries.get(id); if(!e){e={child:false,armed:false,omissions:0,finished:[],epoch:0,tainted:false};this.entries.set(id,e)} return e }
  addChild(id:string):void { this.entry(id).child=true }
  isChild(id:string):boolean { return this.entries.get(id)?.child===true }
  setUsage(id:string, usage:TokenUsage):void { this.entry(id).usage=usage }
  getUsage(id:string):TokenUsage|undefined { return this.entries.get(id)?.usage }
  getEpoch(id:string):number { return this.entry(id).epoch }
  arm(id:string):void { const e=this.entry(id); e.armed=true; e.tainted=false }
  isArmed(id:string):boolean { return this.entry(id).armed }
  start(id:string):boolean { const e=this.entry(id); if(e.tainted||!e.armed)return false; e.window={text:"",ordinals:new Set()}; return true }
  appendText(id:string,messageID:string,ordinal:number,text:string):void { const w=this.entry(id).window; if(!w)return; w.messageID=messageID; const key=`${messageID}:${ordinal}`; if(!w.ordinals.has(key)){w.ordinals.add(key);w.text+=text} }
  finish(id:string,messageID:string):{text:string;epoch:number}|undefined { const e=this.entry(id),w=e.window; if(!w||!e.armed||e.finished.includes(messageID))return; e.finished.push(messageID); while(e.finished.length>32)e.finished.shift(); const result={text:w.text,epoch:e.epoch}; e.window=undefined;e.armed=false; return result }
  isFinished(id:string,messageID:string):boolean { return this.entry(id).finished.includes(messageID) }
  apply(id:string, epoch:number, hasTag:boolean|undefined):number|undefined { const e=this.entry(id); if(e.epoch!==epoch)return; if(hasTag===undefined){this.reset(id);return 0} if(hasTag){this.reset(id);return 0} e.omissions++;return e.omissions }
  invalidateUsage(id:string):void { const e=this.entry(id); e.usage=undefined; this.resetEntry(e,true) }
  fail(id:string):void { this.resetEntry(this.entry(id),true) }
  cutStream():void { for(const e of this.entries.values())if(e.window){e.tainted=true;this.resetEntry(e,true)} }
  reset(id:string):void { const e=this.entry(id);e.omissions=0;e.armed=false;e.window=undefined }
  private resetEntry(e:Entry,epoch:boolean):void { e.omissions=0;e.armed=false;e.window=undefined;if(epoch)e.epoch++ }
  delete(id:string):void { const e=this.entry(id);this.resetEntry(e,true);this.entries.delete(id) }
  clear():void { for(const e of this.entries.values())this.resetEntry(e,true);this.entries.clear() }
}
