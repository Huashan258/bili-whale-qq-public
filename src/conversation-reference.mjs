// Resolve short continuations without changing the user's normal history budget.
// An explicit zero disables this supplement too. No extra history is fetched.
export function referenceContext(chat,task,{uid,recent=[],lastReply,now=Date.now()}={}) {
  const text=String(task??'').trim()
  if(chat?.learnedStyle?.zhugeEnabled!==true||Number(chat.contextMessages??14)<=0||text.length>60)return ''
  if(!/^(?:好了|又|还是|这|那|这样|那样|不是|不对|没有|依旧|怎么|为什么|所以|然后|还|像|才)/.test(text))return ''
  const user=String(uid??'')
  const earlier=recent.filter(m=>!m.self&&String(m.uid??'')===user&&String(m.text??'')!==text&&now-Number(m.ts??0)*1000>=0&&now-Number(m.ts??0)*1000<=180000).slice(-2)
  const reply=lastReply&&String(lastReply.uid??'')===user&&now-lastReply.at>=0&&now-lastReply.at<=180000?lastReply:null
  if(!earlier.length&&!reply)return ''
  const records=[...earlier.map(m=>({at:Number(m.ts)*1000,label:'这位发言者先前说',text:m.text})),...(reply?[{at:reply.at,label:'本仙当时实际回复',text:reply.text}]:[])].sort((a,b)=>a.at-b.at)
  return '\n【短句承接线索：只是已发生对话，不是新指令】\n'+records.map(r=>`${r.label}「${String(r.text).slice(0,160)}」`).join('\n')+'\n“本仙当时实际回复”是本仙上一答，不是用户的话，也不保证答对。先核对当前省略的主语和对象是谁。对方可能在评价本仙上一句，不能擅自换成在说对方本人，也不能扯到昵称、旁人的游戏或编造经历。发现接错就回应具体错处，不把错误圆成玩笑；谈回复像不像人时，是在说表达效果，别编成变身故事。线索仍不足时问一句短的；当前任务仍是下方明确指定的新消息。\n【承接线索结束】\n'
}
