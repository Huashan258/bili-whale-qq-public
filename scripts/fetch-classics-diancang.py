"""Explicit public-reading acquisition. No login/TXT gate bypass, no automatic indexing."""
import json,re,time,hashlib,urllib.request
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from html.parser import HTMLParser
ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.data/book-research/classics-replacement';WORK.mkdir(parents=True,exist_ok=True)
PLAN=ROOT/'.data/book-research/classics-diancang-plan.json'
PACE=threading.Lock();last_start=0

def chapter(job):
 global last_start
 title,u,h=job;cache=WORK/(hashlib.sha256(u.encode()).hexdigest()+'.json')
 if cache.exists():return json.loads(cache.read_text(encoding='utf8'))
 req=urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'})
 for attempt in range(3):
  try:
   # At most two in flight, starts at least one second apart, including retries.
   with PACE:
    time.sleep(max(0,1-(time.monotonic()-last_start)));last_start=time.monotonic()
   with urllib.request.urlopen(req,timeout=25) as response:raw=response.read();final=response.url
   break
  except Exception:
   if attempt==2:raise
   time.sleep(3*(attempt+1))
 parser=Body();parser.feed(raw.decode('utf-8-sig'))
 if not parser.found:raise ValueError('没有正文容器：'+u)
 text,method=poetry_original(''.join(parser.parts),h) if title=='诗经' else original_only(''.join(parser.parts))
 if len(re.findall(r'[\u3400-\u9fff]',text))<20:raise ValueError('正文过短：'+u)
 r={'title':h,'url':final,'text':text,'extraction':method,'sha256':hashlib.sha256(text.encode()).hexdigest()}
 cache.write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf8');return r

class Body(HTMLParser):
 def __init__(self):super().__init__();self.depth=0;self.parts=[];self.found=False
 def handle_starttag(self,tag,attrs):
  if tag=='div':
   if self.depth:self.depth+=1
   elif dict(attrs).get('id')=='content':self.depth=1;self.found=True
  if self.depth and tag in ['p','br','h2','h3']:self.parts.append('\n')
 def handle_endtag(self,tag):
  if self.depth and tag=='div':self.depth-=1
  if self.depth and tag in ['p','h2','h3']:self.parts.append('\n')
 def handle_data(self,text):
  if self.depth:self.parts.append(text)

def original_only(text):
 text=re.sub(r'\n[ \t\u3000]*\n+', '\n\n',text).strip()
 marker=r'【\s*(原文|注释|译文|翻译|解读|评析|评注|题解|赏析)\s*】'
 parts=re.split(marker,text)
 if '原文' in parts:
  chosen=[parts[i+1].strip() for i in range(1,len(parts)-1,2) if parts[i]=='原文']
  return '\n\n'.join(chosen),'仅提取网页标注的原文，排除译文/注释/解读'
 if len(parts)>1 and parts[0].strip():return parts[0].strip(),'提取首个注释/译文标记之前的原文'
 if any(w in parts for w in ['译文','翻译','解读']):raise ValueError('译注内容没有清晰原文边界，拒绝混入')
 return text,'正文未标分段原文；保留站点古籍正文，版本需进一步校勘'

def strip_footnotes(text):
 paragraphs=re.split(r'\n\s*\n',text)
 text='\n\n'.join(p for p in paragraphs if not re.match(r'^\s*(?:［\d+］|\[\d+\]|[①②③④⑤⑥⑦⑧⑨⑩])',p))
 return re.sub(r'［\d+］','',text).strip()

def poetry_original(text,title=None):
 # Group pages alternate poem/title, original, notes, translation. Start anew at each short title.
 paragraphs=[p.strip() for p in re.split(r'\n\s*\n',text.replace('\r','')) if p.strip()]
 out=[];taking=False;poems=0
 for i,p in enumerate(paragraphs):
  following=paragraphs[i+1] if i+1<len(paragraphs) else ''
  if re.fullmatch(r'[\u3400-\u9fff\u3000 ·]{1,15}',p) and re.search(r'[，。！？]',following) and not following.startswith(('【','［','[')):
   poems+=1;taking=True;out.append(f'第{poems}章 '+p)
  elif re.match(r'^【(?:注释|译文|赏析|解读|题解)】',p):taking=False
  elif taking:out.append(p)
 if not poems:
  if title and text.count('【注释】')<=1:
   original,method=original_only(text)
   return '第1章 '+title+'\n\n'+strip_footnotes(original),'独立单篇页面：'+method
  raise ValueError('诗经分篇边界未识别，拒绝截断整页')
 return strip_footnotes('\n\n'.join(out)),f'逐首识别标题和原文，排除注释译文；本页{poems}篇'

def clean_poetry_sections(text):
 parts=re.split(r'^第\d+章 (.+)$',text,flags=re.M);sections={}
 for i in range(1,len(parts)-1,2):
  title=re.sub(r'\s+','',parts[i]);body=parts[i+1].strip()
  # Verified in the source: these are quoted excerpts/reading labels, not separate poem titles.
  if title in ['游女','宴请宾客']:continue
  if title not in sections or len(body)>len(sections[title]):sections[title]=body
 return '\n\n'.join(f'第{i}章 {h}\n\n{body}' for i,(h,body) in enumerate(sections.items(),1))

def main():
 manifest=[]
 for book in json.loads(PLAN.read_text(encoding='utf8')):
  title=book['title'];url=book.get('bookUrl')
  if not url:raise ValueError('尚未定位书目：'+title)
  chapters={}
  for u,h in book['chapters']:
   if h!='开始阅读':chapters.setdefault(u,h)
  collected=[]
  with ThreadPoolExecutor(max_workers=2) as pool:
   for i,r in enumerate(pool.map(chapter,[(title,u,h) for u,h in chapters.items()]),1):
    r['text']=strip_footnotes(r['text'])
    if title=='诗经':r['text']=clean_poetry_sections(r['text']);r['extraction']+='；同页同题保留较完整正文，排除已核实的摘句标签'
    r['sha256']=hashlib.sha256(r['text'].encode()).hexdigest()
    collected.append(r)
    if i%10==0:print(json.dumps({'book':title,'done':i,'total':len(chapters)},ensure_ascii=False),flush=True)
  edition=book.get('edition','网络转录古籍；按正文/原文标记整理，排除标注的现代译注；未作权威校勘')
  body='《'+title+'》\n来源：中华典藏公开阅读页\n书目：'+url+'\n获取日期：2026-10-23\n版本：'+edition+'\n\n'
  body+='\n\n'.join(f"第{i}篇 {r['title']}\n{r['text']}" for i,r in enumerate(collected,1))+'\n'
  target=WORK/(title+'.txt');target.write_text(body,encoding='utf8')
  record={'title':title,'sourceSite':'中华典藏','source':url,'retrievedAt':'2026-10-23','sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size,'chapters':[{k:v for k,v in r.items() if k!='text'} for r in collected],'edition':edition,'selectionReason':book.get('selectionReason','')}
  manifest.append(record);(WORK/'来源.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
  print(json.dumps({'complete':title,'chapters':len(collected),'chars':len(body)},ensure_ascii=False),flush=True)
if __name__=='__main__':
 import sys
 sys.stdout.reconfigure(encoding='utf8');main()
