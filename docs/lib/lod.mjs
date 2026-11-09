import { freeze } from './assets.mjs';
export function selectLODs(manifest, {group,position,viewportHeight,fov,maxFine=4,maxFineBytes=48*1024*1024}={}) {
 if(!Number.isInteger(maxFine)||maxFine<0||maxFine>8||!Number.isFinite(maxFineBytes)||maxFineBytes<0||!['exterior','interior'].includes(group)||!Array.isArray(position)||position.length!==3||!position.every(Number.isFinite)||!Number.isFinite(viewportHeight)||viewportHeight<=0||!Number.isFinite(fov)||fov<=0||fov>=180) throw new Error('Invalid LOD camera/group');
 const required=[],candidates=[];
 for(const part of manifest.parts.filter(p=>p.group===group)) {
  required.push({key:`${part.id}@0`,part,lod:part.lods[0]});
  const radius=Math.hypot(...part.bounds.max.map((v,i)=>(v-part.bounds.min[i])/2));
  const distance=Math.hypot(...position.map((v,i)=>Math.max(part.bounds.min[i]-v,0,v-part.bounds.max[i])));
  const pixels=radius*viewportHeight/(Math.max(.01,distance)*Math.tan(fov*Math.PI/360));
  const level=Math.min(part.lods.length-1,Math.max(0,Math.floor(Math.log2(Math.max(1,pixels/420)))+ (pixels>420?1:0)));
  if(level>0) candidates.push({key:`${part.id}@${level}`,part,lod:part.lods[level],distance});
 }
 candidates.sort((a,b)=>a.distance-b.distance||a.key.localeCompare(b.key)); let bytes=0;
 const refinements=candidates.filter(c=>{if(bytes+c.lod.byteLength>maxFineBytes)return false;bytes+=c.lod.byteLength;return true;}).slice(0,maxFine);
 return {required,refinements};
}

// No unlimited promise/cache fanout: active aborted work occupies its slot until settled.
export class PartStream {
 constructor({load,dispose,onChange=()=>{},maxConcurrent=2,maxBytes=160*1024*1024}) {
  if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>4||!Number.isFinite(maxBytes)||maxBytes<=0)throw new Error('Invalid stream limits');
  this.load=load;this.dispose=dispose;this.onChange=onChange;this.maxConcurrent=maxConcurrent;this.maxBytes=maxBytes;
  this.loaded=new Map();this.active=new Map();this.errors=new Map();this.progress=new Map();this.plan={required:[],refinements:[]};this.wanted=new Map();this.destroyed=false;
 }
 setPlan(plan) {
  if(this.destroyed)return;this.plan=plan;this.wanted=new Map([...plan.required,...plan.refinements].map(x=>[x.key,x]));
  for(const [key,task] of this.active) if(!this.wanted.has(key))task.controller.abort();
  for(const [key,entry] of this.loaded) if(!this.wanted.has(key)){this.dispose(entry.value);this.loaded.delete(key);}
  for(const key of this.errors.keys())if(!this.wanted.has(key))this.errors.delete(key);
  for(const key of this.progress.keys())if(!this.wanted.has(key))this.progress.delete(key);
  this.notify();this.pump();
 }
 get residentBytes(){return [...this.loaded.values()].reduce((s,x)=>s+x.bytes,0);}
 get coarseReady(){return this.plan.required.length>0&&this.plan.required.every(x=>this.loaded.has(x.key));}
 notify(){this.onChange(this.snapshot());}
 pump(){
  if(this.destroyed)return;
  const queue=this.coarseReady?[...this.plan.required,...this.plan.refinements]:this.plan.required;
  for(const item of queue) {
   if(this.active.size>=this.maxConcurrent)break;
   if(this.loaded.has(item.key)||this.active.has(item.key)||this.errors.has(item.key))continue;
   const reserved=[...this.active.values()].reduce((s,x)=>s+(x.reserved??x.item.lod.byteLength),0);
   if(this.residentBytes+reserved+item.lod.byteLength>this.maxBytes){this.errors.set(item.key,'Memory budget exceeded; reduce web LOD size');continue;}
   const controller=new AbortController(),task={controller,item,reserved:item.lod.byteLength};this.active.set(item.key,task);this.progress.set(item.key,0);
   const admit=bytes=>{controller.signal.throwIfAborted();const others=[...this.active.values()].filter(x=>x!==task).reduce((s,x)=>s+x.reserved,0);if(!Number.isFinite(bytes)||bytes<0||this.residentBytes+others+bytes>this.maxBytes)throw new Error('Predecode memory budget exceeded; provide smaller web LOD/atlases');task.reserved=bytes;};
   let promise;try {promise=this.load(item,controller.signal,n=>{if(!controller.signal.aborted){this.progress.set(item.key,n);this.notify();}},admit);}catch(e){promise=Promise.reject(e);}
   Promise.resolve(promise).then(value=>{
    if(this.destroyed||controller.signal.aborted||!this.wanted.has(item.key)){this.dispose(value);return;}
    const bytes=value.residentBytes??item.lod.byteLength;
    if(!Number.isFinite(bytes)||bytes<0||this.residentBytes+bytes>this.maxBytes){this.dispose(value);throw new Error('Resident memory budget exceeded');}
    this.loaded.set(item.key,{value,bytes,item});
   }).catch(e=>{if(!this.destroyed&&!controller.signal.aborted&&this.wanted.has(item.key))this.errors.set(item.key,String(e.message||e));})
    .finally(()=>{this.active.delete(item.key);this.notify();this.pump();});
  }
  this.notify();
 }
 retry(){this.errors.clear();this.pump();}
 visible(){return this.plan.required.map(c=>{const fine=this.plan.refinements.find(f=>f.part.id===c.part.id);return this.loaded.get(fine?.key)?.value??this.loaded.get(c.key)?.value;}).filter(Boolean);}
 snapshot(){return freeze({expectedParts:this.plan.required.length,required:this.plan.required.map(x=>x.key),loaded:[...this.loaded.keys()],coarseReady:this.coarseReady,activeLoads:this.active.size,reservedBytes:[...this.active.values()].reduce((n,t)=>n+t.reserved,0),residentBytes:this.residentBytes,maxBytes:this.maxBytes,errors:[...this.errors].map(([key,message])=>({key,message})),progress:[...this.progress].map(([key,bytes])=>({key,bytes,expected:this.wanted.get(key)?.lod.byteLength??0})),refining:this.plan.refinements.some(x=>!this.loaded.has(x.key))});}
 destroy(){this.destroyed=true;for(const t of this.active.values())t.controller.abort();for(const e of this.loaded.values())this.dispose(e.value);this.loaded.clear();this.progress.clear();}
}
