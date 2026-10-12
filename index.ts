import { Plugin } from "@opencode/plugin"
import { checkpointInstruction } from "./lib/checkpoint-instruction"
import { parseOptions } from "./lib/config"
import { findContextLimit, readContextWindow, type ModelReference, type TokenUsage } from "./lib/context-window"
import { SessionState } from "./lib/session-state"
import { verifyOmission } from "./lib/omission-verifier"

export default Plugin.define({
  id: "flowtask-context-checkpoint",
  async setup(ctx) {
    const log=(cause:string)=>{try{console.warn(`[flowtask-context-checkpoint] ${cause}`)}catch{}}
    const options=parseOptions(ctx.options as Record<string,unknown>,key=>log(`invalid-option:${key}`))
    const state=new SessionState(), controller=new AbortController()
    const contextHook=await ctx.session.hook("context",async event=>{
      if(!options.enabled||!state.isChild(event.sessionID))return
      try {
        const reading=readContextWindow(state.getUsage(event.sessionID))
        if(reading.tokens===undefined){state.invalidateUsage(event.sessionID);log(`measurement-unavailable:${event.sessionID}:${reading.reason??"missing-token-data"}`);return}
        const limit=findContextLimit((await ctx.model.list()).data,event.model as ModelReference)??options.assumedContextLimit
        const ratio=reading.tokens/limit
        if(ratio<options.checkpointThreshold){state.reset(event.sessionID);return}
        event.system.push({type:"text",text:checkpointInstruction(reading.tokens,limit,ratio)})
        state.arm(event.sessionID)
      }catch{log(`context-hook-failed:${event.sessionID}`)}
    })
    const compactionHook=await ctx.session.hook("compaction",event=>state.invalidateUsage(event.sessionID))
    const queues=new Map<string,Promise<void>>()
    let orderLogged=false
    const enqueue=(sessionID:string,messageID:string,epoch:number)=>{
      const previous=queues.get(sessionID)??Promise.resolve()
      const task=previous.then(async()=>{
        const result=await verifyOmission({sessionID,messageID,signal:controller.signal,read:()=>ctx.session.context({sessionID}),log:()=>log(`assistant-message-unavailable:${sessionID}`)})
        const count=state.apply(sessionID,epoch,result.kind==="unknown"?undefined:result.kind==="tag")
        if(count!==undefined&&count>=2)log(`consecutive-omissions:${sessionID}:${count}`)
      }).catch(()=>{})
      queues.set(sessionID,task)
    }
    void (async()=>{
      const delays=[250,500,1000,2000,4000,5000];let failures=0
      while(!controller.signal.aborted&&failures<10){
        let received=false
        try{
          for await(const event of ctx.event.subscribe({signal:controller.signal})){
            received=true;failures=0
            if(event.type==="session.deleted"){state.delete(event.data.sessionID);continue}
            if(event.type==="session.created"){if(event.data.parentID&&event.data.location.directory===ctx.location.directory)state.addChild(event.data.sessionID);continue}
            if(event.type==="session.step.started"){
              if(state.start(event.data.sessionID)&&!orderLogged){orderLogged=true;log(`hook-order-observed:${event.data.sessionID}:context-before-step-started`)}
            }else if(event.type==="session.text.ended"){
              state.appendText(event.data.sessionID,event.data.assistantMessageID,event.data.ordinal,event.data.text)
            }else if(event.type==="session.step.ended"){
              const {sessionID,assistantMessageID,tokens,finish}=event.data
              if(state.isChild(sessionID))state.setUsage(sessionID,tokens as TokenUsage)
              if(finish==="tool-calls")continue
              const done=state.finish(sessionID,assistantMessageID)
              if(!done)continue
              if(done.text.includes("[FLOWTASK_CHECKPOINT_CAPACITY:")){const count=state.apply(sessionID,done.epoch,true);if(count!==undefined)continue}
              else enqueue(sessionID,assistantMessageID,done.epoch)
            }else if(event.type==="session.step.failed"||event.type==="session.execution.failed"||event.type==="session.execution.interrupted")state.fail(event.data.sessionID)
          }
        }catch{if(controller.signal.aborted)break}
        if(controller.signal.aborted)break
        state.cutStream();failures++
        if(failures>=10){log("event-stream-failed");break}
        const delay=delays[Math.min(failures-1,delays.length-1)]
        await new Promise<void>(resolve=>{const timer=setTimeout(resolve,delay);controller.signal.addEventListener("abort",()=>{clearTimeout(timer);resolve()},{once:true})})
        if(!received&&failures===0)failures++
      }
    })()
    return async()=>{controller.abort();state.clear();await Promise.all([contextHook.dispose(),compactionHook.dispose()])}
  },
})
