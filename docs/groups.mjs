import {validateManifest,fetchBytes,sha256,safeFile,freeze,LIMITS} from './lib/assets.mjs';
import {selectLODs} from './lib/lod.mjs';
const names=['exterior','interior'];
function demand(ok,message){if(!ok)throw Error(message);}
const CATALOG_BYTES=2*1024*1024;
const validID=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,90}$/.test(id);
// All descriptor facts are admitted before using them as acquisition limits.
function descriptor(g){
 demand(g&&typeof g==='object'&&!Array.isArray(g)&&names.includes(g.group),'invalid group descriptor');
 safeFile(g.file,'json');
 demand(Number.isSafeInteger(g.byteLength)&&g.byteLength>0&&g.byteLength<=LIMITS.manifestBytes&&typeof g.sha256==='string'&&/^[a-f0-9]{64}$/.test(g.sha256),'invalid child descriptor');
 demand(g.sourcePaths===(g.group==='exterior'?187:65)&&Number.isSafeInteger(g.sourceTriangles)&&g.sourceTriangles>0&&g.sourceTriangles<=97785305,'group scope mismatch');
 demand(Array.isArray(g.ids)&&g.ids.length>0&&g.ids.length<=LIMITS.parts,'invalid group IDs');
 const ids=new Set();for(const id of g.ids){demand(validID(id)&&!ids.has(id),'duplicate/unsafe catalog id');ids.add(id);}
 return g;
}
function preflight(c,catalogBytes,base){
 demand(c&&c.version===1&&c.coverage==='selected-building'&&c.exclusive===true,'explicit exclusive coverage required');
 demand(c.sourcePaths===252&&c.sourceTriangles===97785305,'source scope mismatch');
 demand(Number.isSafeInteger(c.partCount)&&c.partCount>0&&c.partCount<=LIMITS.parts,'invalid aggregate part count');
 demand(Array.isArray(c.groups)&&c.groups.length===2&&c.groups.every((g,i)=>g?.group===names[i]),'exactly two named groups required');
 demand(Number.isSafeInteger(catalogBytes)&&catalogBytes>0&&catalogBytes<=CATALOG_BYTES,'invalid catalog byte length');
 const ids=new Set(),files=new Set();let paths=0,tri=0,bytes=catalogBytes;
 for(const g of c.groups){descriptor(g);const url=new URL(g.file,base).href;demand(!files.has(url),'duplicate manifest');files.add(url);
  for(const id of g.ids){demand(!ids.has(id),'duplicate/unsafe catalog id');ids.add(id);}
  paths+=g.sourcePaths;tri+=g.sourceTriangles;bytes+=g.byteLength;
 }
 demand(paths===c.sourcePaths&&tri===c.sourceTriangles&&ids.size===c.partCount,'aggregate coverage mismatch');
 demand(bytes<=CATALOG_BYTES,'aggregate catalog/manifests budget');
}
function child(descriptor,input){
 // Canonical validateManifest historically coerces regex operands: reject here first.
 demand(Array.isArray(input?.parts)&&input.parts.every(p=>validID(p?.id)),'invalid typed child id');
 const m=validateManifest(input);demand(m.coverage==='partial','child must be explicitly group scoped');demand(m.parts.every(p=>p.group===descriptor.group),'mixed child ownership');const ids=m.parts.map(p=>p.id).sort();demand(JSON.stringify(ids)===JSON.stringify([...descriptor.ids].sort()),'catalog membership mismatch');return m;
}
export function validateCatalog(input,manifests,{base='http://catalog.invalid/',catalogBytes}={}){
 const c=structuredClone(input);preflight(c,catalogBytes??new TextEncoder().encode(JSON.stringify(c)).length,base);
 const assets=new Set();let parts=0;
 for(const g of c.groups){const m=child(g,manifests[g.group]);parts+=m.parts.length;
  const manifestURL=new URL(g.file,base);
  for(const p of m.parts)for(const lod of p.lods){const url=new URL(safeFile(lod.file),manifestURL).href;demand(!assets.has(url),'duplicate aggregate asset URL');assets.add(url);}
 }
 demand(parts===c.partCount,'aggregate coverage mismatch');return freeze(c);
}
export async function fetchGroup(input,base,{signal,fetchImpl}={}){
 const d=descriptor(structuredClone(input));
 const b=await fetchBytes(new URL(d.file,base),{signal,fetchImpl,maxBytes:d.byteLength,expectedBytes:d.byteLength});signal?.throwIfAborted();demand(await sha256(b)===d.sha256,'group manifest SHA mismatch');return child(d,JSON.parse(new TextDecoder().decode(b)));
}
export async function fetchCatalog(base,{fetchImpl}={}){
 const b=await fetchBytes(new URL('catalog.json',base),{fetchImpl,maxBytes:CATALOG_BYTES});const c=JSON.parse(new TextDecoder().decode(b));
 preflight(c,b.byteLength,base); // Wire bytes, never a smaller canonical reserialization.
 const manifests={};for(const g of c.groups)manifests[g.group]=await fetchGroup(g,base,{fetchImpl});
 const catalog=validateCatalog(c,manifests,{base,catalogBytes:b.byteLength});demand(b.byteLength+c.groups.reduce((n,g)=>n+g.byteLength,0)<=CATALOG_BYTES,'encoded catalog aggregate budget');return {catalog,manifests};
}
export class GroupController{
 constructor({stream,catalog,manifests,base,fetchManifestImpl,onPlan=()=>{},onState=()=>{}}){this.stream=stream;this.catalog=validateCatalog(catalog,manifests,{base});this.manifests=freeze(structuredClone(manifests));this.base=new URL(base);this.fetchManifestImpl=fetchManifestImpl;this.onPlan=onPlan;this.onState=onState;this.epoch=0;this.group=null;this.loadingManifest=false;this.error=null;this.manifest=null;}
 snapshot(){return freeze({epoch:this.epoch,group:this.group,loadingManifest:this.loadingManifest,error:this.error,coverage:this.catalog.coverage,activeGroupComplete:!!this.manifest&&!this.loadingManifest&&!this.error});}
 async activate(group,{fine=true,forceFour=false,position=group==='exterior'?[25,-25,30]:[12.7,-3.4,1.35],fov=group==='exterior'?45:72}={}){
  demand(names.includes(group),'unknown group');const epoch=++this.epoch;this.controller?.abort();const controller=new AbortController();this.controller=controller;this.group=group;this.loadingManifest=true;this.manifest=null;this.error=null;this.stream.setPlan({required:[],refinements:[]});this.onState(this.snapshot());const d=this.catalog.groups.find(g=>g.group===group);const url=new URL(d.file,this.base);
  try{const m=child(d,this.fetchManifestImpl?await this.fetchManifestImpl(url,{signal:controller.signal}):await fetchGroup(d,this.base,{signal:controller.signal}));if(epoch!==this.epoch||controller.signal.aborted)return false;demand(JSON.stringify(m)===JSON.stringify(validateManifest(this.manifests[group])),'manifest differs from validated catalog snapshot');const plan=selectLODs(m,{group,position,viewportHeight:700,fov,maxFine:fine?4:0,maxFineBytes:48*1024*1024});
   if(fine&&forceFour){const parts=m.parts.filter(p=>p.lods.length>1);demand(parts.length===4,'four complete dense children required');plan.refinements=parts.map(part=>({part,lod:part.lods[1],key:part.id+'@1'}));}demand(plan.refinements.length<=4&&plan.refinements.reduce((n,x)=>n+x.lod.byteLength,0)<=48*1024*1024,'fine cap');
   const keys=new Set();for(const x of [...plan.required,...plan.refinements]){x.key=`${epoch}:${x.key}`;demand(typeof x.key==='string'&&!keys.has(x.key),'duplicate request/cache key');keys.add(x.key);x.epoch=epoch;x.group=group;x.manifestURL=url.href;}this.manifest=m;this.loadingManifest=false;this.onPlan(plan,m,this.snapshot());this.stream.setPlan(plan);this.onState(this.snapshot());return true;
  }catch(e){if(epoch!==this.epoch||controller.signal.aborted)return false;this.loadingManifest=false;this.error=String(e.message||e);this.onState(this.snapshot());throw e;}
 }
}
