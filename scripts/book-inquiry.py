"""Read-only dimension-first source selection for questions about expression."""
import sqlite3,json,re

def search(api,plan):
 db=api['DB'];norm=api['norm']
 if not db.exists():return {'hits':[]}
 c=sqlite3.connect('file:'+db.as_posix()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 try:
  requested={}
  for dimension,tags in list(plan.get('dimensions',{}).items())[:6]:
   if dimension not in ['情感','主题','场景','用途','体裁','作者']:continue
   if not isinstance(tags,list):continue
   valid=[]
   for tag in tags[:4]:
    if isinstance(tag,str) and len(tag)<=30 and c.execute("select 1 from tag_assignments where entity='article' and dimension=? and tag=? limit 1",(dimension,tag)).fetchone():valid.append(tag)
   if valid:requested[dimension]=valid
   elif dimension=='作者':return {'hits':[]}
  if not requested:return {'hits':[]}
  candidates={};excluded=set(str(x) for x in plan.get('exclude',[])[:12])
  cues=[norm(s) for s in plan.get('cues',[])[:24] if isinstance(s,str) and 0<len(s)<=30]
  clauses=' or '.join('(s.dimension=? and s.tag=?)' for d,tags in requested.items() for t in tags)
  params=[v for d,tags in requested.items() for t in tags for v in (d,t)]
  # Book tags are the union of article tags. They can recover an untagged relevant
  # poem without pretending that its own labels already contain the same tags.
  bookids=[r[0] for r in c.execute('select s.book from book_tag_stats s join books b on b.id=s.book where '+clauses+" group by s.book order by case when b.title like '诗经%' then 0 when b.title like '论语%' then 1 else 2 end,count(distinct s.dimension) desc limit 10",params)]
  booklabels={bid:{} for bid in bookids}
  if bookids:
   for row in c.execute('select book,dimension,tag from book_tag_stats where book in ('+','.join('?' for _ in bookids)+')',bookids):booklabels[row['book']].setdefault(row['dimension'],set()).add(row['tag'])
  groups=[list(dict.fromkeys(api.get('tokens',lambda s:s)(cue).split()))[:8] for cue in cues]
  terms=[group for group in groups if group]
  if bookids and terms:
   expr=' OR '.join('('+' AND '.join('"'+term.replace('"','')+'"' for term in group)+')' for group in terms)
   chunkids=[r['id'] for r in c.execute('select id from chunk_fts where chunk_fts match ? and book in ('+','.join('?' for _ in bookids)+') order by bm25(chunk_fts) limit 30',[expr]+bookids)]
   if chunkids:
    rows=c.execute('select distinct a.*,b.title,b.path from article_chunks ac join articles a on a.id=ac.article join books b on b.id=a.book where ac.chunk in ('+','.join('?' for _ in chunkids)+') and length(a.text) between 35 and 1600',chunkids).fetchall()
    for row in rows:
     if row['id'] not in excluded and not re.search(r' #\d+$',row['heading']):candidates[row['id']]=dict(row)
  # Each branch starts with tag_lookup; emotion is one optional dimension, never a gate.
  for dimension,tags in requested.items():
   for tag in tags:
    rows=c.execute("""select a.id,a.book,a.heading,a.start,a.end,a.text,b.title,b.path
      from tag_assignments t join articles a on a.id=t.id join books b on b.id=a.book
      where t.entity='article' and t.dimension=? and t.tag=? and length(a.text) between 35 and 1600
      order by length(a.text),a.id limit 100""",(dimension,tag)).fetchall()
    for row in rows:
     if row['id'] not in excluded and not re.search(r' #\d+$',row['heading']):candidates[row['id']]=dict(row)
  if not candidates:return {'hits':[]}
  labels={key:{} for key in candidates}
  ids=list(candidates)
  for offset in range(0,len(ids),400):
   batch=ids[offset:offset+400]
   for row in c.execute("select id,dimension,tag from tag_assignments where entity='article' and id in ("+','.join('?' for _ in batch)+')',batch):labels[row['id']].setdefault(row['dimension'],set()).add(row['tag'])
  weights={'主题':7,'场景':8,'用途':3,'情感':2,'作者':10,'体裁':2};scored=[]
  for aid,row in candidates.items():
   matched={d:sorted(set(tags)&labels[aid].get(d,set())) for d,tags in requested.items()}
   matched={d:t for d,t in matched.items() if t}
   if '作者' in requested and '作者' not in matched:continue
   lines=row['text'].splitlines()
   source='\n'.join(lines[1:]) if lines and lines[0].strip()==row['heading'].strip() else row['text']
   body=norm(source)
   evidence=[cue for cue in cues if cue in body]
   if cues and not evidence:continue
   bookmatched={d:sorted(set(tags)&booklabels.get(row['book'],{}).get(d,set())) for d,tags in requested.items()}
   bookmatched={d:t for d,t in bookmatched.items() if t}
   if '场景' in requested and '场景' not in matched:continue
   if '月夜' in requested.get('场景',[]) and '月' in plan.get('query','') and '月' not in body:continue
   if '主题' in requested and '主题' not in matched and not ('主题' in bookmatched and any(len(cue)>=2 for cue in evidence)):continue
   score=sum(weights[d]*len(tags) for d,tags in matched.items())+2*len(matched)+sum(min(10,len(cue)*3) for cue in evidence)
   if re.search('喜欢|喜爱|心意|表白',plan.get('query','')):
    relational=[word for word in ['相知','相悦','相亲','投我','永以为好','知己','喜见','相逢'] if word in body]
    if not relational:continue
    score+=12*sum(word in body for word in ['相悦','相亲','投我','永以为好'])
    if labels[aid].get('主题',set())&{'战争','司法','边塞'} or re.search('愁|悲|怨|泪|病|死|恨|衰|怆|不相知|少相知|不相悦|不相亲|无知己',body):continue
   if re.search('喜欢|喜爱|心意|表白',plan.get('query','')) and '喜悦' in matched.get('情感',[]):score+=12
   if re.search('喜欢|开心|高兴|祝贺',plan.get('query','')):score-=sum(6 for word in ['断肠','死','泪','怨','恨'] if word in body)
   if re.search('安慰|鼓励',plan.get('query','')) and re.search('死|葬|绝望|断肠',body):continue
   if len(row['text'])<=450:score+=2
   if re.search(r'(?:　|\s)句(?:$|[（(])',row['heading']):score-=12
   # Prefer evidence spanning several categories; labels are still candidates, not instructions.
   row['matchedDimensions']=matched
   row['bookDimensions']=bookmatched
   anchor=next(iter(sorted(evidence,key=len,reverse=True)),None)
   at=norm(row['text']).find(anchor) if anchor and len(row['text'])>450 else 0
   start=max(0,at-80)
   boundary=max(row['text'].rfind('\n',0,at),row['text'].rfind('。',0,at))
   if len(row['text'])<=450:start=0
   elif boundary>=0 and at-boundary<160:start=boundary+1
   row['text']=row['text'][start:start+450];row['articleId']=aid
   scored.append((score,row))
  hits=[];seen=set()
  for _,row in sorted(scored,key=lambda x:(-x[0],x[1]['id'])):
   fingerprint=re.sub(r'\s+','',norm(row['text']))
   if fingerprint in seen:continue
   seen.add(fingerprint);hits.append(row)
   if len(hits)==2:break
  return {'mode':'inquiry-dimensions','requestedDimensions':requested,'hits':hits}
 finally:c.close()
