"""Read-only: emotion/topic tags -> short literary articles -> bounded source excerpts."""
import sqlite3,json,re

def search(api,plan):
 db=api['DB'];norm=api['norm']
 if not db.exists():return {'hits':[]}
 if plan.get('inquiry'):
  from pathlib import Path
  import runpy
  return runpy.run_path(str(Path(__file__).with_name('book-inquiry.py')))['search'](api,plan)
 # Semantic bridges are query vocabulary, never invented quotations. Existing search
 # still selects indexed books/tags before matching source fragments.
 bridges={
  'mutual-care':('诗经 木瓜 投我', ['投我','报之','永以为好']),
  'inner-richness':('论语 饭疏食 饮水', ['饭疏食','乐亦在其中','不义而富']),
 }
 bridge=bridges.get(plan.get('theme'))
 if bridge:
  result=api['search'](bridge[0]);hits=[]
  excluded=set(str(s) for s in plan.get('exclude',[])[:12])
  for hit in result.get('hits',[]):
   if hit['id'] in excluded:continue
   text=hit['text'];body=norm(text)
   anchor=next((word for word in bridge[1] if word in body),None)
   if not anchor:continue
   if plan.get('theme')=='inner-richness' and sum(word in body for word in bridge[1])<2:continue
   # OpenCC normalizes characters without moving their offsets in these sources.
   at=body.find(anchor);start=max(0,at-30)
   if start:
    boundary=max(text.rfind('\n',0,at),text.rfind('。',0,at))
    start=boundary+1 if boundary>=0 and at-boundary<160 else start
   end=text.find('\n\n',at)
   if end<0:end=start+450
   item=dict(hit);item['text']=text[start:min(start+450,end)]
   articles=hit.get('articles',[])
   item['articleId']=next((a['id'] for a in articles if a.get('heading')==hit['heading']),hit['id'])
   if item['articleId'] in excluded:continue
   hits.append(item)
   if len(hits)==2:break
  if hits:return {'mode':'conversational-allusion','hits':hits}
 c=sqlite3.connect('file:'+db.as_posix()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 if not c.execute("select 1 from sqlite_master where name='tag_assignments'").fetchone():c.close();return {'hits':[]}
 emotions=[s for s in plan.get('emotions',[])[:3] if s in ['喜悦','愤怒','悲伤','忧愁','孤独','思念','豪迈','宁静']]
 topics=[s for s in plan.get('topics',[])[:3] if s in ['友情','仁爱','亲情','离别','爱情']]
 excluded=set(str(s) for s in plan.get('exclude',[])[:12]);candidates={}
 for tag in emotions:
  rows=c.execute("""select a.*,b.title,b.path from tag_assignments t join articles a on a.id=t.id join books b on b.id=a.book
   where t.entity='article' and t.dimension='情感' and t.tag=? and length(a.text) between 35 and 700
   and (b.title like '%诗%' or b.title like '%论语%' or b.title like '%乐府%' or b.title like '%中庸%')
   order by case when a.text like '%长风破浪%' then 0 else 1 end,case when b.title='全唐诗' then 0 when b.title like '诗经%' then 1 else 2 end,length(a.text) limit 180""",(tag,)).fetchall()
  for row in rows:
   if row['id'] in excluded:continue
   if re.search(r' #\d+$',row['heading']):continue # Fallback fragments can mix unrelated short poems.
   labels=set(json.loads(row['tags']));score=4*len(labels.intersection(emotions))+2*len(labels.intersection(topics))
   # Candidate rules can be broad: require an actual lexical signal, not only a book-level association.
   body=norm(row['text']);evidence={'喜悦':['喜','欢','乐','笑'],'愤怒':['怒','愤','怨'],'悲伤':['悲','哀','泪'],'忧愁':['忧','愁'],'孤独':['孤','独','寂寞'],'思念':['相思','思归','故人','思乡','怀人'],'豪迈':['壮志','豪情','长风破浪'],'宁静':['清静','幽静','恬淡']}
   if not any(w in body for e in emotions for w in evidence[e]):continue
   if plan.get('mood') in ['低落','疲惫','孤独'] and re.search('死|葬|泪|断肠|绝望|无望',body):continue
   if plan.get('mood') in ['低落','疲惫','孤独']:
    if '长风破浪' in body:score+=20
    score+=sum(10 for w in ['会有时','直挂云帆'] if w in body)
    score+=sum(6 for w in ['长风破浪','会有时','自宽','相逢','春风','故人来','安心'] if w in body)
    score-=sum(5 for w in ['泪','苦','死','葬','断肠','绝望','无望','未酬','断绝'] if w in body)
   if plan.get('mood')=='愤怒':score-=sum(8 for w in ['杀','斩','戮','仇','血'] if w in body)
   if len(row['text'])<=450:score+=3
   candidates[row['id']]=(score,dict(row))
 hits=[];seen=set()
 for score,row in sorted(candidates.values(),key=lambda pair:(-pair[0],pair[1]['id'])):
  lines=row['text'].splitlines();body='\n'.join(lines[1:]) if lines and row['heading'] in lines[0] else row['text']
  fingerprint=re.sub(r'\s+','',norm(body))
  if fingerprint in seen:continue
  seen.add(fingerprint);aid=row['id']
  row['id']=aid;row['articleId']=aid;row['text']=row['text'][:450];hits.append(row)
  if len(hits)==2:break
 c.close();return {'mode':'emotional-expression','hits':hits}
