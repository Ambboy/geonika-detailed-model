export const LIMITS = Object.freeze({fileBytes: 99_000_000, manifestBytes: 2_000_000, parts: 1024, coarseBytes: 96 * 1024 * 1024});
const fail = (s) => { throw new Error(s); };
export function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function keys(o, allowed, label) { if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => !allowed.includes(k))) fail(`${label}: unknown fields`); }
function int(n, min = 1, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(n) && n >= min && n <= max; }
export function safeFile(file, extension = 'glb') { if (typeof file !== 'string' || file.length > 180 || !new RegExp(`^[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*\\.(?:${extension})$`).test(file)) fail('Unsafe relative file'); return file; }
export function validBounds(b) { keys(b, ['min','max'], 'bounds'); if (!['min','max'].every(k => Array.isArray(b[k]) && b[k].length === 3 && b[k].every(Number.isFinite)) || !b.min.every((v,i) => v <= b.max[i]) || !b.min.some((v,i) => v < b.max[i])) fail('Invalid bounds'); return b; }
function contains(a,b,tolerance=.02) { return b.min.every((v,i) => v >= a.min[i]-tolerance && b.max[i] <= a.max[i]+tolerance); }
function descriptor(d, ext='glb') { safeFile(d.file, ext); if (!int(d.byteLength, 1, LIMITS.fileBytes) || !/^[a-f0-9]{64}$/.test(d.sha256)) fail('Invalid byteLength or sha256'); }
export function validateManifest(input) {
 const m=structuredClone(input); keys(m,['version','coordinateSystem','assetToSourceRotation','coverage','bounds','parts','externalTextures','views'],'manifest');
 if(m.version!==1 || m.coordinateSystem!=='right-handed-z-up' || m.assetToSourceRotation!=='x+90deg') fail('Unsupported version or coordinate frame');
 if(!['pilot','partial','building'].includes(m.coverage)) fail('Explicit coverage required'); validBounds(m.bounds);
 if(!Array.isArray(m.parts) || !int(m.parts.length,1,LIMITS.parts)) fail('Invalid parts');
 const ids=new Set(), files=new Set(); let coarseBytes=0;
 for(const p of m.parts) {
  keys(p,['id','group','bounds','lods','generatedMaterial','kind'],'part');
  if(!/^[a-zA-Z0-9_-]{1,90}$/.test(p.id)||ids.has(p.id)) fail('Invalid/duplicate part id'); ids.add(p.id);
  if(p.kind!==undefined&&!['measured','reconstructed'].includes(p.kind))fail('Invalid part kind');
  if(!['exterior','interior'].includes(p.group)) fail('Invalid group'); validBounds(p.bounds); if(!contains(m.bounds,p.bounds)) fail('Part bounds outside manifest');
  if(!Array.isArray(p.lods)||!int(p.lods.length,1,5)) fail('Invalid LODs');
  for(const [i,d] of p.lods.entries()) { keys(d,['level','file','byteLength','sha256','triangleCount','vertexCount'],'LOD'); descriptor(d); if(d.level!==i || !int(d.triangleCount,1,8_000_000) || !int(d.vertexCount,3,8_000_000)) fail('Invalid LOD level/count'); if(files.has(d.file)) fail('Duplicate file'); files.add(d.file); }
  coarseBytes+=p.lods[0].byteLength;
  if(p.generatedMaterial) { keys(p.generatedMaterial,['provenance','channels'],'generatedMaterial'); const g=p.generatedMaterial; if(typeof g.provenance!=='string'||g.provenance.length<8||g.provenance.length>400||!Array.isArray(g.channels)||!g.channels.length||g.channels.some(c=>!['basecolor','normal','roughness'].includes(c))||new Set(g.channels).size!==g.channels.length) fail('Invalid generated material provenance'); }
 }
 if(coarseBytes>LIMITS.coarseBytes) fail('Coarse overview exceeds bounded budget; supply smaller web LOD0');
 if(m.externalTextures!==undefined) { if(!Array.isArray(m.externalTextures)||m.externalTextures.length>2048||m.externalTextures.reduce((n,t)=>n+t.byteLength,0)>64*1024*1024) fail('Invalid textures'); for(const t of m.externalTextures) { keys(t,['file','byteLength','sha256'],'texture'); descriptor(t,'png|jpg|jpeg'); if(files.has(t.file)) fail('Duplicate texture file'); files.add(t.file); } }
 if(m.views) { keys(m.views,['exterior','interior'],'views'); for(const v of Object.values(m.views)) { keys(v,['position','target'],'view'); if(!['position','target'].every(k=>Array.isArray(v[k])&&v[k].length===3&&v[k].every(Number.isFinite)) || v.position.every((x,i)=>x===v.target[i])) fail('Invalid view'); } }
 return freeze(m);
}
export async function sha256(buffer) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(v=>v.toString(16).padStart(2,'0')).join(''); }
export async function fetchBytes(url, {fetchImpl=globalThis.fetch, signal, maxBytes, expectedBytes, onProgress=()=>{}}={}) {
 const response=await fetchImpl(url,{signal,redirect:'error',credentials:'omit',cache:'no-cache'});
 if(!response.ok) fail(`HTTP ${response.status}`);
 // Fetch exposes decoded bytes; Content-Length can describe the HTTP-coded wire body.
 const coding=(response.headers.get('content-encoding')||'identity').trim().toLowerCase(), encoded=coding!==''&&coding!=='identity';
 const header=response.headers.get('content-length'); if(header && (!int(Number(header),0,maxBytes)||!encoded&&expectedBytes!==undefined&&Number(header)!==expectedBytes)) fail('Content length mismatch');
 const reader=response.body.getReader(); const chunks=[]; let n=0;
 try { for(;;) { signal?.throwIfAborted(); const {done,value}=await reader.read(); if(done) break; n+=value.length; if(n>maxBytes || expectedBytes!==undefined&&n>expectedBytes) fail('Response length exceeded'); chunks.push(value); onProgress(n); } }
 catch(e) { await reader.cancel().catch(()=>{}); throw e; }
 if(expectedBytes!==undefined&&n!==expectedBytes) fail('Response length truncated');
 const out=new Uint8Array(n); let offset=0; for(const c of chunks) {out.set(c,offset);offset+=c.length;} return out.buffer;
}
export async function fetchVerified(d, base, options={}) { const url=new URL(safeFile(d.file,'glb|png|jpg|jpeg'),base); const buffer=await fetchBytes(url,{...options,maxBytes:d.byteLength,expectedBytes:d.byteLength}); options.signal?.throwIfAborted(); if(await sha256(buffer)!==d.sha256) fail('SHA-256 mismatch'); return buffer; }
export async function fetchManifest(url,options={}) { const buffer=await fetchBytes(url,{...options,maxBytes:LIMITS.manifestBytes}); return validateManifest(JSON.parse(new TextDecoder().decode(buffer))); }

// Fail before GLTFLoader can allocate GPU objects or fetch an unapproved resource.
// Intentionally narrow: static indexed triangles, one source-frame root, PNG/JPEG, no decoders.
export function inspectGLB(buffer, expected, externalTextures=[]) {
 const view=new DataView(buffer); if(buffer.byteLength<28||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength) fail('Invalid GLB header/length');
 let offset=12, doc, bin;
 while(offset<buffer.byteLength) { if(offset+8>buffer.byteLength) fail('GLB truncated chunk'); const length=view.getUint32(offset,true),type=view.getUint32(offset+4,true);offset+=8; if(length%4||offset+length>buffer.byteLength) fail('GLB invalid chunk'); if(type===0x4e4f534a&&!doc) doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,offset,length))); else if(type===0x004e4942&&!bin) bin={offset,length}; else fail('GLB unsupported/duplicate chunk'); offset+=length; }
 if(!doc || !bin || doc.asset?.version!=='2.0'||doc.buffers?.length!==1||doc.buffers[0].uri||!int(doc.buffers[0].byteLength,1,bin.length)||bin.length-doc.buffers[0].byteLength>3) fail('GLB missing embedded buffer');
 if((doc.extensionsUsed||[]).some(x=>x!=='KHR_texture_transform')||(doc.extensionsRequired||[]).some(x=>x!=='KHR_texture_transform')||doc.skins?.length||doc.animations?.length) fail('GLB unsupported extension/animation/skin');
 // GLTFLoader parses every scene, not only doc.scene. Keep its entire mesh graph inside this gate.
 if(!Array.isArray(doc.scenes)||doc.scenes.length!==1||doc.scene!==undefined&&doc.scene!==0) fail('GLB needs exactly one scene (index 0)');
 const roots=doc.scenes[0]?.nodes; if(!Array.isArray(roots)||roots.length!==1) fail('GLB needs one source-frame root');
 if(!Array.isArray(doc.nodes)||!Array.isArray(doc.meshes)||!int(roots[0],0,doc.nodes.length-1)) fail('GLB invalid node/mesh graph');
 const root=doc.nodes[roots[0]], q=[-Math.SQRT1_2,0,0,Math.SQRT1_2];
 if(!root?.rotation || root.rotation.length!==4||!q.every((n,i)=>Math.abs(root.rotation[i]-n)<1e-6)) fail('GLB root must be Rx(-90deg)');
 const seen=new Set(), meshIds=new Set();
 function visit(id) {
  if(!int(id,0,doc.nodes.length-1)) fail('GLB invalid node index');
  if(seen.has(id)) fail('GLB cyclic/reused node'); seen.add(id); const n=doc.nodes[id];
  if(!n||n.matrix||n.translation?.some(x=>x!==0)||n.scale?.some(x=>x!==1)||id!==roots[0]&&n.rotation?.some((x,i)=>Math.abs(x-(i===3?1:0))>1e-8)||n.skin!==undefined) fail('GLB unexpected node transform');
  if(n.mesh!==undefined) { if(!int(n.mesh,0,doc.meshes.length-1)) fail('GLB invalid mesh index'); if(meshIds.has(n.mesh)) fail('GLB instancing unsupported'); meshIds.add(n.mesh); }
  if(n.children!==undefined&&!Array.isArray(n.children)) fail('GLB invalid node children');
  for(const c of n.children||[]) visit(c);
 } visit(roots[0]);
 if(seen.size!==doc.nodes.length||meshIds.size!==doc.meshes.length) fail('GLB unreachable node/mesh graph');
 const geometryViews=new Set();
 const getAccessor=(id) => {geometryViews.add(doc.accessors?.[id]?.bufferView); const a=doc.accessors?.[id], b=doc.bufferViews?.[a?.bufferView]; const bytes={5121:1,5123:2,5125:4,5126:4}[a?.componentType], components={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a?.type]; if(!a||!b||a.sparse||!bytes||!components||b.buffer!==0||!int(a.count)||!int(b.byteLength)||!int(b.byteOffset??0,0)||!int(a.byteOffset??0,0)) fail('GLB invalid accessor'); const stride=b.byteStride??bytes*components,start=(b.byteOffset??0)+(a.byteOffset??0), end=start+(a.count-1)*stride+bytes*components; if(!int(stride,bytes*components,252)||stride%bytes||start%bytes||end>(b.byteOffset??0)+b.byteLength||end>doc.buffers[0].byteLength) fail('GLB accessor range'); return {...a,start:bin.offset+start,stride,bytes,components}; };
 const value=(a,i,c=0)=>view[a.componentType===5126?'getFloat32':a.componentType===5125?'getUint32':a.componentType===5123?'getUint16':'getUint8'](a.start+i*a.stride+c*a.bytes,true);
 let triangles=0,vertices=0; const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
 for(const mid of meshIds) {const mesh=doc.meshes?.[mid]; if(!mesh?.primitives?.length) fail('GLB empty mesh'); for(const p of mesh.primitives) {
  if((p.mode??4)!==4||p.targets||p.extensions) fail('GLB only static indexed triangles'); const pos=getAccessor(p.attributes?.POSITION), idx=getAccessor(p.indices);
  if(pos.type!=='VEC3'||pos.componentType!==5126||idx.type!=='SCALAR'||![5121,5123,5125].includes(idx.componentType)||idx.count%3) fail('GLB invalid triangle attributes');
  for(const [semantic,id] of Object.entries(p.attributes)) {const a=getAccessor(id); if(a.count!==pos.count) fail('GLB attribute count mismatch'); for(let i=0;i<a.count;i++) for(let c=0;c<a.components;c++) {const v=value(a,i,c);if(!Number.isFinite(v)) fail('GLB non-finite attribute'); if(semantic==='POSITION') {bounds.min[c]=Math.min(bounds.min[c],v);bounds.max[c]=Math.max(bounds.max[c],v);} } }
  for(let i=0;i<idx.count;i++) if(value(idx,i)>=pos.count) fail('GLB out-of-range index'); triangles+=idx.count/3;vertices+=pos.count;
  const material=doc.materials?.[p.material]; if((material?.pbrMetallicRoughness?.baseColorTexture||material?.extras?.generatedBaseColorTexture!==undefined)&&p.attributes.TEXCOORD_0===undefined) fail('GLB texture needs UV');
 } }
 if(triangles!==expected.triangleCount||vertices!==expected.vertexCount) fail('GLB actual counts mismatch');
 if(expected.bounds&&(!contains(expected.bounds,bounds)||!contains(bounds,expected.bounds))) fail('GLB source bounds mismatch');
 for(const img of doc.images||[]) { if(img.uri!==undefined) {safeFile(img.uri,'png|jpg|jpeg'); if(!externalTextures.some(t=>t.file===img.uri)) fail('GLB external texture not allowlisted');} else { const b=doc.bufferViews?.[img.bufferView];if(!b||!['image/png','image/jpeg'].includes(img.mimeType)||b.buffer!==0||(b.byteOffset??0)+b.byteLength>bin.length) fail('GLB invalid embedded image');} }
 return {doc,bounds,triangles,vertices,geometryBytes:[...geometryViews].reduce((n,id)=>n+doc.bufferViews[id].byteLength,0)};
}
