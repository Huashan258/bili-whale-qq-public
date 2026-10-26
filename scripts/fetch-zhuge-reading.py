"""Explicit acquisition of two verified public-domain reading editions; never indexes."""
import hashlib,json,re,threading,time,urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.data/book-research/zhuge-learning';INBOX=ROOT/'book/未索引/诸葛亮学习'
LOCK=threading.Lock();last_start=0
class Content(HTMLParser):
 def __init__(self):super().__init__();self.depth=0;self.ignore=0;self.parts=[];self.found=False
 def handle_starttag(self,tag,attrs):
  if tag=='div':
   if self.depth:self.depth+=1
   elif dict(attrs).get('id')=='content':self.depth=1;self.found=True
  if self.depth and tag in ['script','style']:self.ignore+=1
  if self.depth and tag in ['p','br','h2','h3']:self.parts.append('\n')
 def handle_endtag(self,tag):
  if tag in ['script','style'] and self.ignore:self.ignore-=1
  if self.depth and tag=='div':self.depth-=1
  if self.depth and tag in ['p','h2','h3']:self.parts.append('\n')
 def handle_data(self,text):
  if self.depth and not self.ignore:self.parts.append(text)
def fetch(url):
 global last_start
 cache=WORK/(hashlib.sha256(url.encode()).hexdigest()+'.html')
 if cache.exists():return cache.read_text(encoding='utf8')
 for attempt in range(3):
  try:
   with LOCK:
    time.sleep(max(0,1-(time.monotonic()-last_start)));last_start=time.monotonic()
   with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=25) as r:
    if not r.url.startswith('https://www.diancang.xyz/'):raise ValueError('unexpected source redirect')
    text=r.read().decode('utf-8-sig')
   cache.write_text(text,encoding='utf8');return text
  except Exception:
   if attempt==2:raise
   time.sleep(3*(attempt+1))
def chapter(job):
 url,title=job;p=Content();p.feed(fetch(url))
 body=re.sub(r'\n[ \t\u3000\xa0]*\n+','\n\n',''.join(p.parts)).strip()
 if not p.found or len(re.findall(r'[\u3400-\u9fff]',body))<100:raise ValueError('invalid chapter '+url)
 return {'title':title,'url':url,'text':body,'sha256':hashlib.sha256(body.encode()).hexdigest()}
def main():
 WORK.mkdir(parents=True,exist_ok=True);INBOX.mkdir(parents=True,exist_ok=True)
 books=[('三国演义','罗贯中','https://www.diancang.xyz/wenxueyishu/sanguoyanyi/',120),('诸葛亮集','诸葛亮','https://www.diancang.xyz/leishuwenji/zhugeliangji/',4)]
 report=[]
 for title,author,catalog,expected in books:
  html=fetch(catalog);links={}
  for url,name in re.findall(r'<a[^>]+href=[\"\']([^\"\']+)[\"\'][^>]*>([\s\S]*?)</a>',html):
   heading=re.sub('<[^>]+>','',name).strip()
   if url.startswith(catalog) and re.search(r'/\d+\.html$',url) and heading!='开始阅读':links.setdefault(url,heading)
  if len(links)!=expected:raise ValueError(f'{title}: expected {expected}, got {len(links)}')
  chapters=[]
  with ThreadPoolExecutor(max_workers=2) as pool:
   for i,row in enumerate(pool.map(chapter,links.items()),1):
    chapters.append(row)
    if i%10==0:print(json.dumps({'book':title,'downloaded':i,'total':expected},ensure_ascii=False),flush=True)
  header=f'《{title}》\n编著署名：{author}\n来源：中华典藏公开阅读正文\n书目：{catalog}\n获取日期：2026-10-25\n版本说明：网络转录本，保留原文与已有校记，未作权威校勘。小说人物对白不等于历史人物亲笔；文集传本文字归属须逐篇核对。\n\n'
  text=header+'\n\n'.join((row['title'] if title=='三国演义' else f"第{i}卷 {row['title']}")+'\n\n'+row['text'] for i,row in enumerate(chapters,1))+'\n'
  target=INBOX/f'{title}（中华典藏公开阅读本）.txt'
  if target.exists() and target.read_text(encoding='utf8')!=text:raise ValueError('refuse to overwrite different book')
  target.write_text(text,encoding='utf8')
  item={'title':title,'authorCredit':author,'catalog':catalog,'file':str(target.relative_to(ROOT/'book')),'retrievedAt':'2026-10-25','sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'characters':len(text),'chapters':[{k:v for k,v in row.items() if k!='text'} for row in chapters]}
  report.append(item)
  (WORK/(title+'-章节正文.json')).write_text(json.dumps(chapters,ensure_ascii=False,indent=2),encoding='utf8')
  (WORK/'来源.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
  print(json.dumps({'completed':title,'chapters':len(chapters),'characters':len(text)},ensure_ascii=False),flush=True)
 (ROOT/'book/诸葛亮学习来源.json').write_text(json.dumps({'sources':report,'otherSite':'OpenELib已检索，首页超时，未取得可核对版本，不冒称从该站下载。','indexing':'下载脚本不索引；需另行显式限定新书操作。'},ensure_ascii=False,indent=2),encoding='utf8')
if __name__=='__main__':main()
