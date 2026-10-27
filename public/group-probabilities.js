export function validateGroupChances(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>500)throw Error('群概率须为群号与概率的对应表')
 const out={}
 for(const [gid,chance] of Object.entries(value)){
  if(!/^[1-9]\d{2,19}$/.test(gid))throw Error('群号须为3–20位正整数字符串')
  if(typeof chance!=='number'||!Number.isFinite(chance)||chance<0||chance>1)throw Error(`群${gid}的概率须为0–1之间的数值`)
  out[gid]=chance
 }return out
}
export function parseGroupChances(text){
 const out={}
 for(const [i,line] of String(text??'').split(/\r?\n/).entries()){
  if(!line.trim())continue
  const m=line.trim().match(/^([1-9]\d{2,19})\s*[=：:]\s*(\d+(?:\.\d*)?|\.\d+)$/)
  if(!m)throw Error(`第${i+1}行请填写“群号=概率”，例如123456=0.6`)
  if(Object.hasOwn(out,m[1]))throw Error(`群${m[1]}重复填写`)
  out[m[1]]=Number(m[2])
 }return validateGroupChances(out)
}
export const formatGroupChances=value=>Object.entries(value??{}).map(([gid,chance])=>gid+'='+chance).join('\n')
export function groupReplyChance(chat={},gid){
 const value=chat.groupSpeakChances?.[String(gid)]
 if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1)return value
 const fallback=Number(chat.speakChance??.55)
 return Number.isFinite(fallback)?Math.min(1,Math.max(0,fallback)):.55
}
