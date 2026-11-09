export function imageMemory(bytes) {
 const b=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let width,height;
 if(bytes.length>=24&&b.getUint32(0)===0x89504e47&&b.getUint32(4)===0x0d0a1a0a&&b.getUint32(12)===0x49484452){width=b.getUint32(16);height=b.getUint32(20);}
 else if(bytes.length>4&&b.getUint16(0)===0xffd8){let p=2;while(p+4<bytes.length){if(bytes[p++]!==255)break;const marker=bytes[p++];if(marker===0xd9||marker===0xda)break;const n=b.getUint16(p);if(n<2||p+n>bytes.length)break;if([0xc0,0xc1,0xc2].includes(marker)&&n>=7){height=b.getUint16(p+3);width=b.getUint16(p+5);break;}p+=n;}}
 if(!width||!height)throw new Error('Unsupported/corrupt image header');
 if(width>4096||height>4096)throw new Error('Texture dimension budget exceeded');
 return {width,height,bytes:Math.ceil(width*height*4*4/3)};
}
export function textureBudget(images,max=64*1024*1024){const info=images.map(imageMemory);const bytes=info.reduce((s,x)=>s+x.bytes,0);if(bytes>max)throw new Error('Texture GPU budget exceeded; provide web atlases');return {bytes,images:info};}
