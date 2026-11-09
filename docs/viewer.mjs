import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {fetchVerified,inspectGLB,fetchBytes,sha256} from './lib/assets.mjs';
import {PartStream} from './lib/lod.mjs';
import {textureBudget} from './lib/textures.mjs';
import {fetchCatalog,GroupController} from './groups.mjs';
import {RefinementAdapter,frustum,intersects} from './refinement.mjs';
const denseIDs=["p_67c4303fe5f9fccd711997c6_0", "p_67c4303fe5f9fccd711997c6_1", "p_67c4303fe5f9fccd711997c6_2", "p_67c4303fe5f9fccd711997c6_3"];
let exactIDs=null,allocationTable;let adapter,fineEnabled=true,denseBenchmark=false,pendingReplan=false,replanTimer=null,changingView=false;const loadEvents=[];
const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(1000,700,false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
const scene=new THREE.Scene();scene.background=new THREE.Color(0x11171f);scene.add(new THREE.AmbientLight(0xffffff,1.15));const sun=new THREE.DirectionalLight(0xffffff,2.1);sun.position.set(-2,-8,12);scene.add(sun);
const camera=new THREE.PerspectiveCamera(45,1000/700,.02,300);camera.up.set(0,0,1);const controls=new OrbitControls(camera,renderer.domElement);const loader=new GLTFLoader();let manifest,group='exterior',view='exterior',mode='generated',reconstructed=true,completed=0,plan={required:[],refinements:[]},stream,controller,drawQueued=false;const roots=new Set(),errors=[];let disposed=0;
const views={closeup:{eye: [12.669080196824915, -2.9516628539612775, 1.3268101476186869], target: [12.31917235512948, -1.1514112122857938, 1.0073749518058421], fov: 48},exterior:{eye:[25,-25,30],target:[12,0,4.5],fov:45},interior:{eye:[12.7,-3.4,1.35],target:[12.3,2.4,1.05],fov:72},dense:{eye:[6.687101761650273,1.9453509847208843,1.2953205276870032],target:[6.5713677406311035,5.005145072937013,1.030138373374939],fov:55},frontal:{eye:[5.1,5,1.4],target:[6.57,5,1.03],fov:65},roof:{eye:[18,-13,20],target:[13.8,-.2,8.2],fov:42},facade:{eye:[8,-9,2],target:[9,-5.5,1.5],fov:55}};
// At most one in-flight and one completed main presentation. Auxiliary rasters
// never enter this transaction, and parsed assets are not submission evidence.
let presentationRevision=0,mainInFlight=null,lastMain=null,mainValid=false;
const emptyMainCounts={triangles:0,points:0,calls:0};
function selectedItems(){const fine=new Map(plan.refinements.map(x=>[x.part.id,x]));return plan.required.map(x=>fine.get(x.part.id)??x);}
function presentationIdentity(){return JSON.stringify([presentationRevision,controller?.epoch,group,mode,reconstructed,camera.position.toArray(),camera.quaternion.toArray(),camera.projectionMatrix.elements,controls.target.toArray(),renderer.domElement.width,renderer.domElement.height,selectedItems().map(x=>x.key)]);}
function invalidatePresentation(){presentationRevision++;mainValid=false;updateStatus();}
function mainEvidence(){
 const current=mainValid&&lastMain?.identity===presentationIdentity();
 const visible=new Map((stream?.visible()??[]).map(r=>[r.userData.key,r]));
 const records=current?lastMain.records.filter(x=>visible.get(x.key)?.uuid===x.instance):[];
 const submitted=records.filter(x=>x.drawn>0).map(x=>x.key);
 const accepted=new Set(records.filter(x=>x.expected>0&&x.drawn+x.hidden===x.expected).map(x=>x.key));
 return {current,submitted,accepted};
}
const isExact=x=>x.lod.level===x.part.lods.length-1&&x.lod.level>0;
// UI reads the same readiness transaction as QA; never schedules or forces a draw.
function presentationReady(s,g,e,counts){return !pendingReplan&&!!s&&!!g?.activeGroupComplete&&!g.loadingManifest&&!g.error&&s.coarseReady&&s.activeLoads===0&&s.errors.length===0&&!s.refining&&e.current&&counts.triangles>0&&selectedItems().every(x=>s.loaded.includes(x.key)&&e.accepted.has(x.key));}
function detailCounts(s,e){
 const tier=predicate=>{const selected=plan.refinements.filter(predicate),loaded=selected.filter(x=>s?.loaded.includes(x.key));return {selected:selected.length,loaded:loaded.length,pending:selected.length-loaded.length,submitted:loaded.filter(x=>e.accepted.has(x.key)).length};};
 return {medium:tier(x=>!isExact(x)),exact:tier(isExact),meaning:'selected=current plan; loaded=selected resident; pending=selected not resident; submitted=accepted current completed main frame'};
}
function updateStatus(){
 const s=stream?.snapshot(),g=controller?.snapshot(),e=mainEvidence(),counts=lastMain?.counts??emptyMainCounts,d=detailCounts(s,e);
 const ready=presentationReady(s,g,e,counts),failed=!!g?.error||!!s?.errors.length||!!errors.length;
 const tier=(name,x)=>`${name} ${x.loaded}/${x.selected} загружено/выбрано (ожидает ${x.pending})`;
 document.querySelector('#status').textContent=`${failed?'Ошибка':ready?'Готово покрытие текущего вида':'Загрузка'} · ${group} · ${counts.triangles} triangles последнего завершённого кадра · ${tier('medium',d.medium)} · ${tier('exact fine',d.exact)} · ${mode} · Частичная детализация: два галерейных блока`;
}
function spatialState(){
 const result={loadedOffscreen:[],loadedInView:[],cachedInactiveInView:[],cachedFallback:[],spatialUnknown:[],spatialDefinition:{predicate:'unchanged refinement.frustum/intersects; conservative bounds, not pixel visibility or LOD selection',expandedFovDegrees:10,boundsToleranceMeters:.021,group,epoch:controller?.epoch,camera:null,valid:false}};
 let f;const valid=manifest&&manifest===controller?.manifest&&group===controller.group&&!controller.loadingManifest&&!controller.error&&!changingView;
 if(valid)try{result.spatialDefinition.camera=currentCamera();f=frustum(result.spatialDefinition.camera);result.spatialDefinition.valid=true;}catch{}
 const active=new Set(stream?.visible()??[]),required=new Set(plan.required.map(x=>x.key)),parts=new Map((manifest?.parts??[]).map(p=>[p.id,p]));
 for(const r of roots){const x=r.userData,p=parts.get(x.id);if(!f||x.group!==group||x.epoch!==controller.epoch||!p){result.spatialUnknown.push(x.key);continue;}
  if(!intersects(p,f)){result.loadedOffscreen.push(x.key);continue;}
  result.loadedInView.push(x.key);if(!active.has(r)){result.cachedInactiveInView.push(x.key);if(x.level===0&&required.has(x.key))result.cachedFallback.push(x.key);}
 }
 return result;
}
function snapshot(){const s=stream?.snapshot(),g=controller?.snapshot(),e=mainEvidence(),counts=lastMain?.counts??emptyMainCounts;return structuredClone({ready:presentationReady(s,g,e,counts),detailCounts:detailCounts(s,e),group,groupState:g,view,mode,reconstructed,coverage:manifest?.coverage,catalogCoverage:g?.coverage,partialDetail:true,detailScope:"view-scoped coverage; optional medium in 26 plain gallery parts; max four exact fine; not full-group residency or whole-building fine",selectedFine:plan.refinements.filter(isExact).map(x=>x.part.id),loadedFine:s?.loaded.filter(k=>plan.refinements.some(x=>x.key===k&&isExact(x))),submittedFine:plan.refinements.filter(x=>isExact(x)&&e.submitted.includes(x.key)&&s?.loaded.includes(x.key)).map(x=>x.part.id),pendingReplan,replans:adapter?.replans,loadEvents:[...loadEvents],completedRenders:completed,triangles:counts.triangles,points:counts.points,drawCalls:counts.calls,stream:s,submittedParts:e.submitted.map(k=>k.slice(k.indexOf(':')+1,k.lastIndexOf('@'))),submittedKeys:e.submitted,selectedKeys:selectedItems().map(x=>x.key),mainFrameCurrent:!!e.current,presentationRevision,completedMainFrame:lastMain,requiredFine:plan.refinements.filter(isExact).map(x=>x.key),requiredMedium:plan.refinements.filter(x=>!isExact(x)).map(x=>x.key),viewScope:plan.viewScope,allocation:plan.allocation,...spatialState(),generatedBindings:[...roots].flatMap(r=>r.userData.entries.filter(x=>x.generated).map(x=>({part:r.userData.id,association:x.association,provenance:x.kind,vertexColors:x.original.vertexColors,normalOff:!x.original.normalMap,mapColorSpace:x.original.map?.colorSpace,roughnessColorSpace:x.original.roughnessMap?.colorSpace,baselineAttribute:!!x.mesh.geometry.attributes._baseline_color}))),rootOwnership:[...roots].map(r=>({part:r.userData.id,group:r.userData.group,epoch:r.userData.epoch})),disposedAssets:disposed,memory:{...renderer.info.memory},rendererControlReserveBytes:8388608+65536,camera:{eye:camera.position.toArray(),target:controls.target.toArray(),up:camera.up.toArray(),fov:camera.fov},errors});}
function draw(){if(!stream)return;const visible=new Set(stream.visible());for(const r of roots){r.visible=visible.has(r);for(const e of r.userData.entries){e.mesh.visible=reconstructed||e.kind!=='reconstructed';e.mesh.material=mode==='depth'?e.depth:mode==='clay'?e.clay:mode==='baseline'&&e.generated?e.baseline:e.original;if(e.generated){if(mode==='baseline')e.mesh.geometry.setAttribute('color',e.mesh.geometry.attributes._baseline_color);else e.mesh.geometry.deleteAttribute('color');}}}mainValid=false;
 const frame={identity:presentationIdentity(),revision:presentationRevision,epoch:controller.epoch,group,selectedKeys:selectedItems().map(x=>x.key),drawn:new Set()};
 mainInFlight=frame;
 try{
  if(renderer.getRenderTarget()!==null)throw Error('main canvas target required');
  renderer.render(scene,camera);
  const gl=renderer.getContext();gl.finish();
  if(gl.isContextLost()||gl.getError()!==gl.NO_ERROR)throw Error('main render did not complete');
  const records=[...visible].map(r=>({key:r.userData.key,part:r.userData.id,epoch:r.userData.epoch,level:r.userData.level,instance:r.uuid,expected:r.userData.entries.length,drawn:r.userData.entries.filter(e=>frame.drawn.has(e.mesh)).length,hidden:r.userData.entries.filter(e=>!reconstructed&&e.kind==='reconstructed'&&!e.mesh.visible).length}));
  // Commit only after the entire render/finish succeeds; a failed draw leaves the
  // previous counters intact but cannot certify the now-damaged main canvas.
  lastMain={identity:frame.identity,revision:frame.revision,epoch:frame.epoch,group:frame.group,selectedKeys:frame.selectedKeys,records,counts:{triangles:renderer.info.render.triangles,points:renderer.info.render.points,calls:renderer.info.render.calls},sequence:++completed};
  mainValid=frame.identity===presentationIdentity();
 }finally{mainInFlight=null;updateStatus();}
 return snapshot();}
function schedule(){updateStatus();if(drawQueued)return;drawQueued=true;requestAnimationFrame(()=>{drawQueued=false;if(stream.snapshot().activeLoads===0){draw();if(pendingReplan)refineNow();}});}
function dispose(root){scene.remove(root);roots.delete(root);const textures=new Set(),materials=new Set(),geometry=new Set();for(const e of root.userData.entries){geometry.add(e.mesh.geometry);for(const m of [e.original,e.baseline,e.clay,e.depth])if(m){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}}for(const t of textures){t.dispose();t.source?.data?.close?.();}for(const m of materials)m.dispose();for(const g of geometry)g.dispose();disposed++;}
async function load(item,signal,onProgress,admit){
 loadEvents.push({key:item.key,part:item.part.id,level:item.lod.level,epoch:item.epoch,at:performance.now()});
 const b=await fetchVerified(item.lod,new URL(item.manifestURL),{signal,onProgress});signal.throwIfAborted();if(item.epoch!==controller.epoch||item.group!==controller.group)throw Error('stale asset epoch');const x=inspectGLB(b,{...item.lod,bounds:item.part.bounds});const n=new DataView(b).getUint32(12,true),off=28+n;const images=(x.doc.images||[]).map(im=>{const bv=x.doc.bufferViews[im.bufferView];return new Uint8Array(b,off+(bv.byteOffset||0),bv.byteLength)});const tb=textureBudget(images);const residentBytes=2*(x.geometryBytes+tb.bytes);const row=adapter.costs.get(item.part.id+'@'+item.lod.level);if(!row||row.residentBytes!==residentBytes||row.geometryBytes!==x.geometryBytes||row.imageBytesWithMips!==tb.bytes||row.encoded!==b.byteLength||row.sha256!==item.lod.sha256)throw Error('allocation inspector mismatch');admit(residentBytes+b.byteLength+8388608+65536);const gltf=await loader.parseAsync(b,'');const root=new THREE.Group();root.rotation.x=Math.PI/2;root.add(gltf.scene);root.residentBytes=residentBytes;root.userData={id:item.part.id,key:item.key,group:item.group,epoch:item.epoch,level:item.lod.level,entries:[]};
 try{gltf.scene.traverse(mesh=>{if(!mesh.isMesh)return;const association=gltf.parser.associations.get(mesh);if(!association||association.primitives===undefined)throw Error('missing primitive association');const p=gltf.parser.json.meshes[association.meshes].primitives[association.primitives],ex=p.extras||{};const original=mesh.material;const generated=ex.appearance==='generated-not-measured';const entry={mesh,association,original,baseline:null,clay:null,generated,kind:ex.provenance};root.userData.entries.push(entry);if(generated&&(!original.map||original.vertexColors||original.normalMap||!mesh.geometry.attributes._baseline_color))throw Error('generated binding invalid');entry.baseline=generated?new THREE.MeshStandardMaterial({color:new THREE.Color().fromArray(ex.baselineFactor||[1,1,1]),vertexColors:true,flatShading:!mesh.geometry.attributes.normal,roughness:ex.baselineRoughness??1,metalness:0,side:THREE.DoubleSide}):null;entry.clay=new THREE.MeshStandardMaterial({color:0x8493a0,flatShading:!mesh.geometry.attributes.normal,roughness:1,metalness:0,side:THREE.DoubleSide});entry.depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide});mesh.frustumCulled=false;mesh.onAfterRender=()=>{if(mainInFlight&&renderer.getRenderTarget()===null&&root.visible&&item.epoch===mainInFlight.epoch&&item.group===mainInFlight.group)mainInFlight.drawn.add(mesh);};});signal.throwIfAborted();if(item.epoch!==controller.epoch||item.group!==controller.group)throw Error('stale parsed epoch');scene.add(root);roots.add(root);return root;}catch(e){dispose(root);throw e;}
}
function currentCamera(){camera.updateMatrixWorld();return {eye:camera.position.toArray(),target:controls.target.toArray(),fov:camera.fov,aspect:camera.aspect,near:camera.near,far:camera.far};}
function requestRefine(){invalidatePresentation();pendingReplan=true;clearTimeout(replanTimer);replanTimer=setTimeout(refineNow,100);schedule();}
function refineNow(){clearTimeout(replanTimer);if(!adapter||!manifest||controller.loadingManifest)return;pendingReplan=false;const visibility=fineEnabled&&!denseBenchmark&&stream.coarseReady?rasterIDs(250,175).parts:null;adapter.update(currentCamera(),{enabled:fineEnabled,dense:denseBenchmark,visibility,exactIDs});schedule();}
async function setView(name,{fine=true}={}){if(!views[name])throw Error('unknown view');invalidatePresentation();view=name;fineEnabled=fine;denseBenchmark=['dense','frontal'].includes(name);const next=['interior','closeup','dense','frontal'].includes(name)?'interior':'exterior';const x=views[name];changingView=true;camera.position.fromArray(x.eye);controls.target.fromArray(x.target);camera.fov=x.fov;camera.lookAt(...x.target);camera.updateProjectionMatrix();camera.updateMatrixWorld();controls.update();changingView=false;const same=controller.group===next&&controller.manifest&&!controller.error&&!controller.loadingManifest;group=next;pendingReplan=true;if(!same){manifest=null;plan={required:[],refinements:[]};await controller.activate(group,{fine:false,forceFour:false,position:x.eye,fov:x.fov});}refineNow();requestRefine();return true;}
function setPose(p){invalidatePresentation();changingView=true;camera.position.fromArray(p.eye);controls.target.fromArray(p.target);if(p.fov)camera.fov=p.fov;camera.lookAt(...p.target);camera.updateProjectionMatrix();controls.update();changingView=false;denseBenchmark=false;pendingReplan=true;refineNow();return currentCamera();}
function setFine(v){invalidatePresentation();fineEnabled=!!v;pendingReplan=true;refineNow();return snapshot();}
function rasterIDs(w=500,h=350){
 const visible=new Set(stream.visible());for(const r of roots)r.visible=visible.has(r);
 const rt=new THREE.WebGLRenderTarget(w,h,{depthBuffer:true,stencilBuffer:false});rt.texture.colorSpace=THREE.NoColorSpace;
 const prev=renderer.getRenderTarget(),bg=scene.background,entries=[],mats=[],parts={};const ids=manifest.parts.map(p=>p.id);scene.background=new THREE.Color(0);
 for(const r of roots){const code=ids.indexOf(r.userData.id)+1;const mat=new THREE.MeshBasicMaterial({color:new THREE.Color().setRGB((code&255)/255,((code>>8)&255)/255,0,THREE.LinearSRGBColorSpace),side:THREE.DoubleSide,toneMapped:false});mats.push(mat);for(const e of r.userData.entries){entries.push([e.mesh,e.mesh.material]);e.mesh.material=mat;e.mesh.visible=reconstructed||e.kind!=='reconstructed';}}
 renderer.setRenderTarget(rt);renderer.render(scene,camera);const b=new Uint8Array(w*h*4);renderer.readRenderTargetPixels(rt,0,0,w,h,b);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const off=(y*w+x)*4,code=b[off]+256*b[off+1];if(code<1||code>ids.length)continue;const id=ids[code-1];const q=parts[id]??(parts[id]={pixels:0,weighted:0});q.pixels++;q.weighted+=Math.exp(-18*((x/w-.5)**2+(y/h-.5)**2));}
 for(const [mesh,mat] of entries)mesh.material=mat;for(const mat of mats)mat.dispose();scene.background=bg;renderer.setRenderTarget(prev);rt.dispose();
 const fine=new Set([...roots].filter(r=>r.visible&&r.userData.level>0&&r.userData.level===manifest.parts.find(p=>p.id===r.userData.id)?.lods.length-1).map(r=>r.userData.id));let finePixels=0;const perFine={};for(const id of fine){perFine[id]=parts[id]?.pixels||0;finePixels+=perFine[id];}
 return {width:w,height:h,parts,finePixels,perFine,method:'depth-tested GPU part-ID raster; actual active representations',raw:b};
}
function visibleDetail(){const {raw,...r}=rasterIDs();draw();return r;}
function idMask(){const r=rasterIDs();const cv=document.createElement('canvas');cv.width=r.width;cv.height=r.height;const ctx=cv.getContext('2d'),im=ctx.createImageData(r.width,r.height);for(let y=0;y<r.height;y++)im.data.set(r.raw.subarray((r.height-1-y)*r.width*4,(r.height-y)*r.width*4),y*r.width*4);ctx.putImageData(im,0,0);draw();return cv.toDataURL('image/png');}

function setMode(x){if(!['generated','baseline','clay','depth'].includes(x))throw Error('mode');if(mode!==x)invalidatePresentation();mode=x;return draw();}
function setReconstructed(x){if(reconstructed!==!!x)invalidatePresentation();reconstructed=!!x;return draw();}
function pixels(){const gl=renderer.getContext(),b=new Uint8Array(1000*700*4);gl.readPixels(0,0,1000,700,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;}
function differences(a,b,mask){let n=0;for(let i=0;i<a.length;i+=4)if((!mask||mask[i/4])&&(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]))n++;return n;}
function coverage(){const p=pixels();let nonBackground=0;for(let i=0;i<p.length;i+=4)if(p[i]!==17||p[i+1]!==23||p[i+2]!==31)nonBackground++;return {nonBackgroundPixels:nonBackground,totalPixels:700000,fraction:nonBackground/700000};}
function compare(){setMode('baseline');const a=pixels();setMode('generated');const b=pixels();setMode('baseline');const c=pixels();const changed=differences(a,b),restored=differences(a,c);setMode('generated');return {changedPixels:changed,restoredPixels:restored,baseline:'same web geometry before generated finish; not removed pre-reconstruction master'};}
function textureInfluence(){setMode('generated');const a=pixels(),changed=[];for(const r of roots)for(const e of r.userData.entries)if(e.generated){changed.push([e.original,e.original.map,e.original.roughnessMap,e.original.metalnessMap]);e.original.map=null;e.original.roughnessMap=null;e.original.metalnessMap=null;e.original.needsUpdate=true;}draw();const b=pixels();for(const [m,map,roughness,metalness] of changed){m.map=map;m.roughnessMap=roughness;m.metalnessMap=metalness;m.needsUpdate=true;}draw();const c=pixels();return {textureChangedPixels:differences(a,b),restoredPixels:differences(a,c),actualGeneratedMaterials:changed.length};}
function retainedControl(){
 // Independent raster mask from actual ungenerated retained geometry, with generated
 // faces black and depth-active. Fully covered white pixels only, not an empty ROI.
 setMode('baseline');const a=pixels();setMode('generated');const b=pixels();
 const originalBackground=scene.background,entries=[],owned=[];
 let mask,count=0,failed=false,failure;
 // Attempt every cleanup even if disposal fails, without replacing the render error.
 const cleanup=fn=>{try{fn();}catch(error){if(!failed){failed=true;failure=error;}}};
 try{
  const black=new THREE.MeshBasicMaterial({color:0,side:THREE.DoubleSide});owned.push(black);
  const white=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide});owned.push(white);
  // The auxiliary main-canvas pass is not a completed main presentation.
  // Refresh UI synchronously; do not force a frame merely to clear READY.
  invalidatePresentation();
  scene.background=new THREE.Color(0);
  for(const r of roots)for(const e of r.userData.entries){entries.push([e.mesh,e.mesh.material]);e.mesh.material=e.generated?black:white;}
  renderer.render(scene,camera);renderer.getContext().finish();
  const m=pixels();mask=new Uint8Array(700000);
  for(let i=0;i<m.length;i+=4)if(m[i]===255&&m[i+1]===255&&m[i+2]===255){mask[i/4]=1;count++;}
 }catch(error){failed=true;failure=error;}
 finally{
  cleanup(()=>{scene.background=originalBackground;});
  for(const [mesh,material] of entries)cleanup(()=>{mesh.material=material;});
  for(const material of owned)cleanup(()=>material.dispose());
 }
 if(failed)throw failure;
 draw();return {protectedPixels:count,changedProtectedPixels:differences(a,b,mask),mask:'fully covered native retained ungenerated primitive pixels; generated black depth occluders; no erosion',notSpecificSemanticObjectGuarantee:true};
}
try{const ab=await fetchBytes(new URL('allocation.json',location.href),{maxBytes:2097152,expectedBytes:147892});if(await sha256(ab)!=='a10958e9593503edc765be59d411b88549db009630ce85093315922fd1189b7e')throw Error('allocation SHA mismatch');allocationTable=JSON.parse(new TextDecoder().decode(ab));const {catalog,manifests}=await fetchCatalog(new URL('./',location.href));stream=new PartStream({load,dispose,onChange:schedule,maxConcurrent:1,maxBytes:160*1024*1024});controller=new GroupController({stream,catalog,manifests,base:new URL('./',location.href),onPlan:(p,m,state)=>{invalidatePresentation();plan=p;manifest=m;adapter.bind(p,m,state,currentCamera());},onState:schedule});adapter=new RefinementAdapter({stream,controller,costs:allocationTable,denseIDs,onPlan:p=>{invalidatePresentation();plan=p;}});function setDelivery({scoped=true,medium=true,exact=null}={}){invalidatePresentation();adapter.scoped=!!scoped;adapter.medium=!!medium;exactIDs=exact;pendingReplan=true;refineNow();return snapshot();}window.deliveryQA={setDelivery,setPose,setFine,visibleDetail,idMask,snapshot,setView,setMode,setReconstructed,compare,textureInfluence,retainedControl,coverage,draw};await setView('interior',{fine:true});for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>setView(b.dataset.view).catch(e=>{errors.push(String(e));updateStatus();});for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>setMode(b.dataset.mode);document.querySelector('#recon').onchange=e=>setReconstructed(e.target.checked);controls.addEventListener('change',()=>{if(!changingView){denseBenchmark=false;requestRefine();}schedule();});}catch(e){errors.push(e.stack);window.deliveryError=e.stack;document.querySelector('#status').textContent=e.stack;throw e;}
