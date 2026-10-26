// PCM16 WAV only: no external codec, preserve all chunks and sample timing.
export function normalizeVoiceWav(source,{volume=100,targetDbfs=-16,boostDb=0}={}) {
  if(source.length<44||source.toString('ascii',0,4)!=='RIFF'||source.toString('ascii',8,12)!=='WAVE')throw Error('无效WAV')
  let format,offset,size
  for(let p=12;p+8<=source.length;) {
    const type=source.toString('ascii',p,p+4)
    const declared=source.readUInt32LE(p+4)
    // Cloud streaming WAV uses an unknown-length sentinel for its final data chunk.
    const streaming=type==='data'&&declared>=0x7fff0000&&source.readUInt32LE(4)>=0x7fff0000
    const length=streaming?source.length-p-8:declared,end=p+8+length
    if(end>source.length)throw Error('WAV数据不完整')
    if(type==='fmt '&&length>=16)format={encoding:source.readUInt16LE(p+8),bits:source.readUInt16LE(p+22)}
    if(type==='data'){offset=p+8;size=length}
    p=end+(length%2)
  }
  if(format?.encoding!==1||format.bits!==16||offset===undefined||!size||size%2)throw Error('需要PCM16 WAV音频')
  const level=Number(volume),target=Number(targetDbfs),boost=Number(boostDb)
  if(!Number.isFinite(level)||!Number.isFinite(target)||!Number.isFinite(boost)||boost<0||boost>20)throw Error('无效响度设置')
  let power=0,peak=0
  for(let p=offset;p<offset+size;p+=2){const x=source.readInt16LE(p)/32768;power+=x*x;peak=Math.max(peak,Math.abs(x))}
  const rms=Math.sqrt(power/(size/2)),ceiling=10**(-1/20)
  const desired=10**(Math.max(-24,Math.min(-12,target))/20)*Math.max(0,Math.min(100,level))/100
  const gain=desired===0?0:rms<1e-5?1:Math.min(desired/rms,10,ceiling/peak)
  const bytes=Buffer.from(source)
  // Final downloaded WAV has a known length; make it playable by strict codecs too.
  bytes.writeUInt32LE(bytes.length-8,4);bytes.writeUInt32LE(size,offset-4)
  const extraGain=10**(boost/20),knee=.7,width=ceiling-knee
  let afterPower=0,afterPeak=0,limitedSamples=0
  for(let p=offset;p<offset+size;p+=2){
    let sample=source.readInt16LE(p)/32768*gain*extraGain
    // Soft knee preserves quiet speech; loud peaks approach the ceiling smoothly.
    if(boost>0&&Math.abs(sample)>knee){sample=Math.sign(sample)*(knee+width*Math.tanh((Math.abs(sample)-knee)/width));limitedSamples++}
    const x=Math.round(sample*32768);bytes.writeInt16LE(x,p);afterPower+=(x/32768)**2;afterPeak=Math.max(afterPeak,Math.abs(x/32768))
  }
  return {bytes,stats:{rmsBefore:rms,rmsAfter:Math.sqrt(afterPower/(size/2)),peakBefore:peak,peakAfter:afterPeak,gainDb:gain?20*Math.log10(gain):null,boostDb:boost,limitedSamples,ceilingLimited:rms>0&&gain<desired/rms}}
}
