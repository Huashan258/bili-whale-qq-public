"""Semantic search must use real fragments, crop around evidence and keep real IDs."""
import runpy,tempfile,pathlib
search=runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1]/'scripts/book-emotion.py'))['search']
with tempfile.TemporaryDirectory() as tmp:
 db=pathlib.Path(tmp)/'test.sqlite';db.touch()
 calls=[]
 def lookup(query):
  calls.append(query)
  return {'hits':[
   {'id':'wrong','text':'无关的邻接片段','heading':'别篇','articles':[]},
   {'id':'book:000045','text':'无关前文。'*150+'\n子曰：“饭疏食饮水，曲肱而枕之，乐亦在其中矣。”\n后文','heading':'述而','articles':[],'title':'论语','start':1,'end':20},
  ]}
 api={'DB':db,'norm':lambda x:x,'search':lookup}
 r=search(api,{'theme':'inner-richness'})
 assert calls==['论语 饭疏食 饮水']
 assert len(r['hits'])==1 and len(r['hits'][0]['text'])<=450
 assert '饭疏食饮水' in r['hits'][0]['text']
 assert r['hits'][0]['id']==r['hits'][0]['articleId']=='book:000045'
 assert db.stat().st_size==0
print('allusion: real source filtering, centered excerpt, bounded text, truthful IDs, read-only passed')
