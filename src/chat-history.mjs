import fs from 'node:fs'
const visible=e=>['in','out','guest','forward-read'].includes(e.type)||e.type==='error'&&e.why
/** Byte cursors survive new appends; filter before limiting, without reading the whole log. */
export function readChatHistory(file,{before,limit=150,query='',maxBytes=8*1024*1024}={}){
 let fd
 const rows=[];limit=Math.max(1,Math.min(200,Math.floor(Number(limit)||150)));query=String(query).trim().slice(0,120).toLowerCase()
 try{
  fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size
  if(before!==undefined&&(!/^\d+$/.test(String(before))||!Number.isSafeInteger(Number(before))))throw Error('invalid cursor')
  const end=before===undefined?size:Math.min(size,Number(before));let pos=end,carry=Buffer.alloc(0),scanned=0
  const add=(bytes,offset)=>{try{const e=JSON.parse(bytes.toString('utf8'));if(visible(e)&&(!query||[e.text,e.from,e.uid,e.group,e.groupName,e.quote?.name,e.quote?.text].some(v=>String(v??'').toLowerCase().includes(query))))rows.push(e)}catch{};return rows.length>=limit?{rows:rows.reverse(),nextBefore:offset,hasMore:offset>0}:null}
  while(pos>0&&scanned<maxBytes){const length=Math.min(pos,65536),chunk=Buffer.alloc(length);pos-=length;fs.readSync(fd,chunk,0,length,pos);scanned+=length;const bytes=Buffer.concat([chunk,carry]);let right=bytes.length
   for(let i=bytes.length-1;i>=0;i--)if(bytes[i]===10){const result=add(bytes.subarray(i+1,right),pos+i+1);if(result)return result;right=i}
   carry=bytes.subarray(0,right)
  }
  if(pos===0){const result=add(carry,0);if(result)return result}
  const nextBefore=pos===0?0:pos+carry.length
  return {rows:rows.reverse(),nextBefore,hasMore:nextBefore>0}
 }catch{return {rows:[],nextBefore:0,hasMore:false}}finally{if(fd!==undefined)fs.closeSync(fd)}
}
