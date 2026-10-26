"""Explicit replacement: validate and index all nine new editions before deleting old ones."""
import runpy,json,hashlib,sqlite3,subprocess,sys,shutil,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];BOOK=ROOT/'book';INDEX=BOOK/'索引'
WORK=ROOT/'.data/book-research/classics-replacement'
NAMES=['大学','中庸','论语','孟子','诗经','尚书','礼记','周易','春秋']

def main():
 new=json.loads((WORK/'来源.json').read_text(encoding='utf8'))
 old=json.loads((INDEX/'四书五经来源.json').read_text(encoding='utf8'))
 if {r['title'] for r in new}!=set(NAMES) or {r['title'] for r in old}!=set(NAMES):raise ValueError('新旧来源必须恰好对应九部书')
 newhashes={r['sha256'] for r in new};oldhashes={r['sha256'] for r in old}
 if newhashes==oldhashes:
  print(json.dumps({'status':'already-current','replaced':0,'deleted':0},ensure_ascii=False));return
 if newhashes & oldhashes:raise ValueError('新旧版本存在重合，拒绝删除在用版本')
 c=sqlite3.connect(INDEX/'library.sqlite');oldrows=[];newtitles=[]
 library=runpy.run_path(str(ROOT/'scripts/book-library.py'));normalize=library['norm']
 minimum={'大学':1500,'中庸':3000,'论语':16000,'孟子':30000,'诗经':25000,'尚书':20000,'礼记':70000,'周易':18000,'春秋':12000}
 anchors={'大学':['大学之道'],'中庸':['天命之谓性'],'论语':['学而时习之','天之历数在尔躬'],'孟子':['王何必曰利'],'诗经':['关关雎鸠','殷武'],'尚书':['曰若稽古'],'礼记':['毋不敬'],'周易':['潜龙勿用'],'春秋':['元年春王正月','获麟']}
 for r in new:
  p=WORK/(r['title']+'.txt')
  if hashlib.sha256(p.read_bytes()).hexdigest()!=r['sha256'] or not r['chapters']:raise ValueError('新版本校验失败')
  if not r['source'].startswith('https://www.diancang.xyz/'):raise ValueError('非指定来源')
  text=normalize(p.read_text(encoding='utf8'));compact=re.sub(r'[^\u3400-\u9fffA-Za-z0-9]','',text)
  if len(text)<minimum[r['title']] or any(a not in compact for a in anchors[r['title']]):raise ValueError('长度或关键篇章缺失：'+r['title'])
 for r in old:
  bid=r['sha256'][:16];row=c.execute('select path,sha from books where id=?',(bid,)).fetchone()
  if not row or row[1]!=r['sha256']:raise ValueError('旧索引与来源不一致')
  p=(BOOK/row[0]).resolve()
  if not p.is_relative_to((BOOK/'已索引').resolve()) or hashlib.sha256(p.read_bytes()).hexdigest()!=row[1]:raise ValueError('旧文件路径或散列不符')
  oldrows.append((bid,p,r))
 oldids={b for b,p,r in oldrows}
 untouched={r[0]:(r[1],r[2],r[3]) for r in c.execute('select id,path,sha,chunks from books') if r[0] not in oldids}
 for r in new:
  edition_match=re.search(r'《([^》]+)》',r['edition']);edition_title=edition_match[1] if edition_match else '原文'
  title=r['title']+'（中华典藏·'+edition_title+'）';newtitles.append(title);p=BOOK/'未索引'/(title+'.txt')
  indexed=c.execute('select 1 from books where id=?',(r['sha256'][:16],)).fetchone()
  if not indexed:
   if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()!=r['sha256']:raise ValueError('未索引区有不同同名版本')
   if not p.exists():shutil.copyfile(WORK/(r['title']+'.txt'),p)
 result=subprocess.run([sys.executable,'scripts/book-library.py','index',*newtitles],cwd=ROOT,capture_output=True,encoding='utf8',check=True)
 report=json.loads(result.stdout)
 if any(r.get('status')=='unindexed' for r in report['report']):raise ValueError(report['report'])
 subprocess.run([sys.executable,'scripts/book-library.py','retag',*newtitles],cwd=ROOT,check=True)
 for r in new:
  bid=r['sha256'][:16]
  if not c.execute('select 1 from books where id=? and chunks>0',(bid,)).fetchone() or not c.execute('select 1 from articles where book=?',(bid,)).fetchone():raise ValueError('新版本索引不完整，拒绝删除旧版本')
 # All replacement books are ready. Remove only exact old hashes in one transaction.
 with c:
  for bid,p,r in oldrows:
   c.execute('delete from article_chunks where article like ?',(bid+':article:%',))
   c.execute('delete from tag_assignments where id like ?',(bid+'%',))
   for table,col in [('articles','book'),('article_fts','book'),('book_tag_stats','book'),('chunks','book'),('chunk_fts','book'),('books','id'),('book_fts','id')]:c.execute(f'delete from {table} where {col}=?',(bid,))
   for table in ['article_tags','book_tags']:
    if c.execute('select 1 from sqlite_master where name=?',(table,)).fetchone():c.execute(f'delete from {table} where book=?',(bid,))
 for bid,p,r in oldrows:p.unlink()
 after={r[0]:(r[1],r[2],r[3]) for r in c.execute('select id,path,sha,chunks from books') if r[0] in untouched}
 if after!=untouched:raise ValueError('其他书籍的索引发生变化，需检查')
 catalog=[dict(zip(['id','title','path','sha256','tags','encoding','chunks'],r)) for r in c.execute('select * from books')]
 (INDEX/'书目.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2),encoding='utf8')
 ids={r['id'] for r in catalog};summary=[r for r in json.loads((INDEX/'多标签汇总.json').read_text(encoding='utf8')) if r['id'] in ids]
 (INDEX/'多标签汇总.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
 md=['# 书籍多维标签汇总','','标签为规则候选；fragment-fallback表示以片段代替未识别的篇章。','','|书籍|篇章/代用单元数|标签数|口径|','|---|---:|---:|---|']
 md += [f"|{r['title']}|{r['articleCount']}|{r['tagCount']}|{r['countingUnit']}|" for r in summary]
 md += ['','完整维度、各标签文章数/片段数及覆盖率见「多标签汇总.json」。']
 (INDEX/'多标签汇总.md').write_text('\n'.join(md),encoding='utf8')
 (INDEX/'四书五经旧版删除记录.json').write_text(json.dumps({'deletedAt':'2026-10-23','reason':'用户要求改从中华典藏与OpenELib查找并删除旧版','oldSources':old,'deletedIds':[b for b,p,r in oldrows],'newSources':new},ensure_ascii=False,indent=2),encoding='utf8')
 (INDEX/'四书五经来源.json').write_text(json.dumps(new,ensure_ascii=False,indent=2),encoding='utf8')
 c.close();print(json.dumps({'replaced':len(new),'deleted':len(oldrows),'books':len(catalog)},ensure_ascii=False))
if __name__=='__main__':sys.stdout.reconfigure(encoding='utf8');main()
