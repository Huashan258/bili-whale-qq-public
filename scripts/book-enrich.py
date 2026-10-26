"""Explicit retagging of indexed sources, with stable article IDs and tag rollup."""
import json,re,sqlite3,runpy
from collections import Counter,defaultdict

def enrich(api):
 norm,tokens,extract=api['norm'],api['tokens'],api['extract']
 BOOK,INDEX=api['BOOK'],api['INDEX'];c=api['connect']()
 tax=runpy.run_path(str(api['ROOT']/'scripts/book-taxonomy.py'))
 rules={d:{t:[norm(w) for w in ws] for t,ws in ts.items()} for d,ts in tax['DIMENSIONS'].items()}
 def labels(text,author=None,credit=None):
  normalized=norm(text)
  result={d:[t for t,ws in ts.items() if any(w in normalized for w in ws)] for d,ts in rules.items()}
  if author:result['作者']=author if isinstance(author,list) else [author]
  if credit:result['编著署名']=[credit]
  return {d:ts for d,ts in result.items() if ts}
 def flat(ds):return sorted({t for ts in ds.values() for t in ts})
 c.executescript('''
 CREATE TABLE IF NOT EXISTS articles(id TEXT PRIMARY KEY,book TEXT,heading TEXT,start INTEGER,end INTEGER,text TEXT,tags TEXT);
 CREATE TABLE IF NOT EXISTS tag_assignments(entity TEXT,id TEXT,dimension TEXT,tag TEXT,PRIMARY KEY(entity,id,dimension,tag));
 CREATE INDEX IF NOT EXISTS tag_lookup ON tag_assignments(entity,dimension,tag,id);
 CREATE TABLE IF NOT EXISTS article_chunks(article TEXT,chunk TEXT,PRIMARY KEY(article,chunk));
 CREATE INDEX IF NOT EXISTS chunks_book_lines ON chunks(book,start,end);
 CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(id UNINDEXED,book UNINDEXED,terms,detail=none);
 CREATE TABLE IF NOT EXISTS book_tag_stats(book TEXT,dimension TEXT,tag TEXT,articles INTEGER,fragments INTEGER,articleCoverage REAL,PRIMARY KEY(book,dimension,tag));
 ''')
 summary=[];only=api.get('retag_titles',[])
 previous={r['id']:r for r in json.loads((INDEX/'多标签汇总.json').read_text(encoding='utf8'))} if only and (INDEX/'多标签汇总.json').exists() else {}
 for bid,title,path,total in c.execute('select id,title,path,chunks from books').fetchall():
  if only and title not in only:
   if bid in previous:summary.append(previous[bid])
   continue
  original,_=extract(BOOK/path);lines=original.replace('\r\n','\n').replace('\r','\n').splitlines()
  sections=[];begin=1;heading='正文';author=None;classic=norm(title).split('-')[0]
  fixed=next((a for key,a in tax['AUTHOR_BOOKS'].items() if key in classic),None)
  credit_match=re.search(r'-(?:[^-]{0,8})-([\u3400-\u9fff]{2,10})$',title)
  credit=norm(credit_match[1]) if credit_match else None
  # These downloaded editions have explicit provenance headers; novel speaker != author.
  zhuge_edition=title=='诸葛亮集（中华典藏公开阅读本）'
  if title=='三国演义（中华典藏公开阅读本）':fixed='罗贯中';credit='罗贯中'
  if zhuge_edition:credit='诸葛亮'
  if re.search(r'^版本：朱熹《论语集注》',original,re.M):fixed=['孔子','朱熹']
  if re.search(r'^版本：朱熹《(?:大学章句|中庸章句|孟子集注|周易本义)》',original,re.M):fixed=([fixed] if isinstance(fixed,str) else fixed or [])+['朱熹']
  if re.search(r'^版本：孔颖达等《尚书正义》',original,re.M):fixed=['孔颖达']
  if re.search(r'^版本：郑玄注、孔颖达疏《礼记正义》',original,re.M):fixed=['郑玄','孔颖达']
  for ln,line in enumerate(lines,1):
   s=line.strip();m=re.match(r'^([\u3400-\u9fff]{2,5})\u3000+(\S.*)$',s) if any(k in title for k in ['全宋诗','作者测试']) else None
   tang=re.match(r'^卷\d+_\d+\s*【.+】\s*([\u3400-\u9fff]{2,5})\s*$',s) if title=='全唐诗' else None
   fields=s.split('，')
   metadata=len(fields)>1 and any(len(f)<30 and norm(f.strip())==classic for f in fields[1:])
   bracketed=bool(re.match(r'^《[^》]+》\s*《[^》]+》$',s)) and ('《'+classic+'》') in norm(s)
   work_heading=zhuge_edition and bool(re.fullmatch(r'[\u3400-\u9fff]{2,22}',s)) and s not in ['诸葛亮集']
   is_heading=len(s)<100 and (work_heading or bool(m) or bool(re.match(r'^(?:第[一二三四五六七八九十百千\d]+[卷章篇回节]|卷[一二三四五六七八九十百千\d]+)',s)) or metadata or bracketed)
   if is_heading:
    if ln>begin and '\n'.join(lines[begin-1:ln-1]).strip():sections.append((heading,begin,ln-1,author))
    begin=ln;heading=s;author=norm(tang[1]) if tang else norm(m[1]) if m else ('诸葛亮' if zhuge_edition and s in ['前出师表','出师表','诫子书','诫外甥书','诫外生书','又诫子书'] else fixed)
  if begin<=len(lines):sections.append((heading,begin,len(lines),author or fixed))
  rows=c.execute('select id,heading,start,end,text from chunks where book=? order by start,end,id',(bid,)).fetchall()
  unit='article' if len(sections)>1 else 'fragment-fallback'
  if unit=='fragment-fallback':sections=[(h+' #'+str(i+1),s,e,fixed) for i,(_,h,s,e,t) in enumerate(rows)]
  acount=Counter();fcount=Counter();article_labels={};articles=[]
  with c:
   for table,column in [('articles','book'),('article_fts','book'),('book_tag_stats','book')]:c.execute(f'delete from {table} where {column}=?',(bid,))
   c.execute('delete from article_chunks where article like ?',(bid+':article:%',))
   c.execute('delete from tag_assignments where id like ?',(bid+'%',))
   for i,(h,start,end,a) in enumerate(sections):
    text='\n'.join(lines[start-1:end]) if unit=='article' else rows[i][4]
    if not text.strip():continue
    aid=f'{bid}:article:{i+1:06d}';ds=labels(h+' '+text,a,credit)
    if title=='三国演义（中华典藏公开阅读本）':ds.setdefault('体裁',[]).append('章回小说')
    if zhuge_edition:
     if h.endswith('书'):ds.setdefault('体裁',[]).append('书信')
     if h.endswith('表'):ds.setdefault('体裁',[]).append('奏表')
     if h in ['诫子书','诫外生书','又诫子书']:ds.setdefault('用途',[]).extend(['教育教化','修身养性'])
    ds={d:sorted(set(ts)) for d,ts in ds.items()};tags=flat(ds)
    c.execute('insert into articles values(?,?,?,?,?,?,?)',(aid,bid,h,start,end,text,json.dumps(tags,ensure_ascii=False)))
    c.execute('insert into article_fts values(?,?,?)',(aid,bid,tokens(h+' '+' '.join(tags))))
    for d,ts in ds.items():
     for t in ts:acount[d,t]+=1;c.execute('insert into tag_assignments values(?,?,?,?)',('article',aid,d,t))
    article_labels[aid]=ds;articles.append((aid,start,end))
   # Intervals overlap: one old fragment may contain multiple short poems. Record all links.
   cursor=0;oldterms={r[1]:r[0] for r in c.execute('select rowid,id from chunk_fts where book=?',(bid,))}
   for cid,h,start,end,text in rows:
    while cursor<len(articles) and articles[cursor][2]<start:cursor+=1
    linked=[];j=cursor
    while j<len(articles) and articles[j][1]<=end:
     linked.append(articles[j][0]);j+=1
    ds=labels(h+' '+text,credit=credit)
    for aid in linked:
     c.execute('insert or ignore into article_chunks values(?,?)',(aid,cid))
     for a in article_labels[aid].get('作者',[]):ds.setdefault('作者',[]).append(a)
    ds={d:sorted(set(ts)) for d,ts in ds.items()};tags=flat(ds)
    c.execute('update chunks set tags=? where id=?',(json.dumps(tags,ensure_ascii=False),cid))
    if cid in oldterms:c.execute('delete from chunk_fts where rowid=?',(oldterms[cid],))
    c.execute('insert into chunk_fts values(?,?,?)',(cid,bid,tokens(title+' '+h+' '+text+' '+' '.join(tags))))
    for d,ts in ds.items():
     for t in ts:fcount[d,t]+=1;c.execute('insert into tag_assignments values(?,?,?,?)',('fragment',cid,d,t))
   # Books are strictly the union of article tags, not title guesses or fragment-only labels.
   bookdims=defaultdict(list)
   for (d,t),n in acount.items():
    bookdims[d].append(t);c.execute('insert into tag_assignments values(?,?,?,?)',('book',bid,d,t))
    c.execute('insert into book_tag_stats values(?,?,?,?,?,?)',(bid,d,t,n,fcount[d,t],n/max(1,len(articles))))
   tags=flat(bookdims);c.execute('update books set tags=? where id=?',(json.dumps(tags,ensure_ascii=False),bid))
   c.execute('delete from book_fts where id=?',(bid,));c.execute('insert into book_fts values(?,?)',(bid,tokens(title+' '+' '.join(tags))))
  summary.append({'id':bid,'title':title,'tagCount':len(tags),'articleCount':len(articles),'countingUnit':unit,'dimensions':dict(bookdims),'tags':[{'dimension':d,'tag':t,'articles':n,'fragments':fcount[d,t],'articleCoverage':round(n/max(1,len(articles)),4)} for (d,t),n in sorted(acount.items())]})
  print(json.dumps({'progress':title,'articles':len(articles),'tags':len(tags)},ensure_ascii=False),flush=True)
 catalog=[dict(zip(['id','title','path','sha256','tags','encoding','chunks'],r)) for r in c.execute('select * from books')]
 for filename,data in [('书目.json',catalog),('多标签汇总.json',summary),('标签分类.json',{'version':2,'dimensions':{**tax['DIMENSIONS'],'作者':{'description':'从作者＋全角空格＋篇名的结构标题提取；单作者书采用明确的作者映射。无可靠结构不猜作者。'}},'notes':'规则生成的候选标签；书籍标签严格取文章并集。无可靠篇章结构标记fragment-fallback。'})]:
  (INDEX/filename).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')
 report=['# 书籍多维标签汇总','','标签为规则生成的候选分类；篇章单元不等同于已人工校勘的独立作品。fragment-fallback表示未识别可靠章题，以原片段作代用单元。','','|书籍|篇章/代用单元数|标签数|口径|','|---|---:|---:|---|']
 report += [f"|{r['title']}|{r['articleCount']}|{r['tagCount']}|{r['countingUnit']}|" for r in summary]
 report += ['','完整维度及各标签文章数、片段数、覆盖率见同目录「多标签汇总.json」。','书籍标签严格汇总文章并集；不读取未索引目录。']
 (INDEX/'多标签汇总.md').write_text('\n'.join(report),encoding='utf8')
 c.close()
