// View-scoped residency pilot. Full catalog identity remains owned by immutable groups.mjs.
import * as T from './vendor/three/build/three.module.js';
import {validBounds,freeze} from './lib/assets.mjs';
const check=(x,m)=>{if(!x)throw Error(m);};
export const CAP=167772160,RESERVE=8454144;
export function frustum(camera){
 check(camera&&['eye','target'].every(k=>Array.isArray(camera[k])&&camera[k].length===3&&camera[k].every(Number.isFinite)),'invalid camera vectors');
 check(Number.isFinite(camera.fov)&&camera.fov>0&&camera.fov<169&&Number.isFinite(camera.aspect)&&camera.aspect>0&&Number.isFinite(camera.near)&&camera.near>0&&Number.isFinite(camera.far)&&camera.far>camera.near,'invalid camera projection');
 check(camera.eye.some((v,i)=>v!==camera.target[i]),'invalid camera direction');
 const c=new T.PerspectiveCamera(camera.fov+10,camera.aspect,camera.near,camera.far);c.up.set(0,0,1);c.position.fromArray(camera.eye);c.lookAt(...camera.target);c.updateMatrixWorld();
 return new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(c.projectionMatrix,c.matrixWorldInverse));
}
export function intersects(part,f){validBounds(part.bounds);return f.intersectsBox(new T.Box3(new T.Vector3().fromArray(part.bounds.min),new T.Vector3().fromArray(part.bounds.max)).expandByScalar(.021));}
export function validateCosts(input,manifests){
 check(input?.version===1&&input.capBytes===CAP&&input.reserveBytes===RESERVE&&Array.isArray(input.rows),'invalid allocation table');const rows=new Map();
 const all=Object.values(manifests).flatMap(m=>m.parts).flatMap(p=>p.lods.map(l=>({p,l})));check(input.rows.length===all.length,'incomplete allocation table');
 for(const r of input.rows){const k=r.id+'@'+r.level;check(!rows.has(k),'duplicate allocation row');check(['encoded','geometryBytes','imageBytesWithMips','imageInstances','residentBytes'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0),'invalid allocation cost');check(r.residentBytes===2*(r.geometryBytes+r.imageBytesWithMips),'underdeclared allocation');rows.set(k,freeze(structuredClone(r)));}
 for(const {p,l} of all){const r=rows.get(p.id+'@'+l.level);check(r&&r.id===p.id&&r.group===p.group&&r.file===l.file&&r.sha256===l.sha256&&r.encoded===l.byteLength&&r.finest===(l.level===p.lods.length-1&&l.level>0),'allocation identity mismatch');}return rows;
}
export class RefinementAdapter{
 constructor({controller,stream,costs,onPlan=()=>{},denseIDs=[]}){check(controller.stream===stream,'one stream required');this.controller=controller;this.stream=stream;this.onPlan=onPlan;this.denseIDs=[...denseIDs];this.costs=validateCosts(costs,controller.manifests);this.replans=0;this.scoped=true;this.medium=true;this.last=null;}
 item(part,lod){return {part,lod,key:`${this.epoch}:${part.id}@${lod.level}`,epoch:this.epoch,group:this.group,manifestURL:this.url};}
 bind(plan,manifest,state,camera){check(plan.refinements.length===0,'activate coarse only');check(state.epoch===this.controller.epoch&&state.group===this.controller.group&&manifest===this.controller.manifest,'unadmitted manifest');this.manifest=manifest;this.epoch=state.epoch;this.group=state.group;this.url=new URL(this.controller.catalog.groups.find(g=>g.group===state.group).file,this.controller.base).href;const p=this.make(camera,{enabled:false});Object.assign(plan,p);this.last=plan;}
 cost(items){const rows=items.map(x=>this.costs.get(x.part.id+'@'+x.lod.level));return rows.reduce((s,r)=>s+r.residentBytes,0)+Math.max(0,...rows.map(r=>r.encoded))+RESERVE;}
 make(camera,{enabled=true,visibility=null,dense=false,exactIDs=null}={}){
 const f=frustum(camera),parts=this.manifest.parts.filter(p=>this.group!=='interior'||!this.scoped||intersects(p,f));check(parts.length,'empty required view');
 const required=parts.map(p=>this.item(p,p.lods[0]));check(this.cost(required)<=CAP,'coarse required coverage exceeds unchanged cap');
 const score=p=>visibility?.[p.id]?.weighted??1/(.1+Math.hypot(...p.bounds.min.map((v,i)=>(v+p.bounds.max[i])/2-camera.eye[i])));
 let candidates=parts.filter(p=>p.lods.length>1&&(exactIDs?exactIDs.includes(p.id):dense?this.denseIDs.includes(p.id):intersects(p,f)&&(!visibility||visibility[p.id]?.pixels>0))).sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id));
 if(exactIDs){check(new Set(exactIDs).size===exactIDs.length&&exactIDs.length<=4,'invalid exact cohort');check(exactIDs.every(id=>candidates.some(p=>p.id===id)),'exact fine outside required/admitted cohort');candidates=exactIDs.map(id=>candidates.find(p=>p.id===id));}
 const refinements=[];let encoded=0;
 if(enabled)for(const p of candidates){if(refinements.length>=4)break;const l=p.lods.at(-1),item=this.item(p,l);if(encoded+l.byteLength<=50331648&&this.cost([...required,...refinements,item])<=CAP){refinements.push(item);encoded+=l.byteLength;}}
 const fineIDs=new Set(refinements.map(x=>x.part.id));
 if(this.medium&&this.group==='interior')for(const p of [...parts].sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id))){if(p.lods.length!==3||fineIDs.has(p.id))continue;const item=this.item(p,p.lods[1]);if(this.cost([...required,...refinements,item])<=CAP)refinements.push(item);}
 const plan={required,refinements};const keys=new Set();for(const x of [...required,...refinements]){check(this.manifest.parts.includes(x.part)&&x.part.lods[x.lod.level]===x.lod&&x.key===`${this.epoch}:${x.part.id}@${x.lod.level}`&&!keys.has(x.key),'invalid active binding');keys.add(x.key);}
 plan.allocation={estimatedPeakBytes:this.cost([...required,...refinements]),capBytes:CAP,controlBytes:RESERVE,conservativeAllResidentPlusLargestEncoded:true};
 plan.viewScope={mode:this.scoped&&this.group==='interior'?'conservative-current-view':'full-group',catalogParts:this.manifest.parts.length,requiredParts:required.length,omittedBounds:this.manifest.parts.length-required.length,expandedFovDegrees:10,boundsToleranceMeters:.021,reason:'inspector allows 20mm bounds tolerance; 1mm extra floating-plane guard',camera:structuredClone(camera),exact:refinements.filter(x=>x.lod.level===x.part.lods.length-1).map(x=>x.key),medium:refinements.filter(x=>x.part.lods.length===3&&x.lod.level===1).map(x=>x.key)};return plan;
 }
 update(camera,options={}){const c=this.controller;if(!this.manifest||c.loadingManifest||c.error||this.manifest!==c.manifest||this.epoch!==c.epoch||this.group!==c.group)return false;const plan=this.make(camera,options);this.last=plan;this.replans++;this.onPlan(plan);this.stream.setPlan(plan);return plan;}
}
