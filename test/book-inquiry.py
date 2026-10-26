import sqlite3,tempfile,pathlib,runpy,hashlib
search=runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1]/'scripts/book-inquiry.py'))['search']
with tempfile.TemporaryDirectory() as tmp:
 db=pathlib.Path(tmp)/'library.sqlite';c=sqlite3.connect(db)
 c.executescript('''create table books(id text,title text,path text);
 create table articles(id text,book text,heading text,start int,end int,text text);
 create table tag_assignments(entity text,id text,dimension text,tag text);
 create table book_tag_stats(book text,dimension text,tag text);
 create table article_chunks(article text,chunk text);
 create virtual table chunk_fts using fts5(id unindexed,book unindexed,terms,detail=none);''')
 c.execute('insert into books values(?,?,?)',('b','测试诗集','测试诗集.txt'))
 def article(aid,heading,text,labels):
  c.execute('insert into articles values(?,?,?,?,?,?)',(aid,'b',heading,1,4,text))
  for dimension,tag in labels:
   c.execute('insert into tag_assignments values(?,?,?,?)',('article',aid,dimension,tag))
   c.execute('insert into book_tag_stats values(?,?,?)',('b',dimension,tag))
 article('b:article:1','喜赠','故人相知相悦，欢喜在心。愿以温柔相赠，念彼相逢之乐，岁岁相与同行，久久不忘今日。',[('情感','喜悦'),('主题','友情'),('用途','人际交往')])
 article('b:article:2','月下','月色入窗，想起故人。远路虽长，愿将这份思念寄去，相逢时把一夜的话慢慢说尽。',[('主题','友情'),('场景','月夜')])
 article('b:article:3','春游','春风吹开桃花，山水相映。沿着清溪慢行，林间的鸟声带来明亮而清新的春意。',[('主题','山水'),('场景','春景')])
 article('b:article:4','木瓜','投我以木瓜，报之以琼琚，匪报也，永以为好也。投我以木桃，报之以琼瑶，匪报也，永以为好也。',[])
 c.execute('insert into chunk_fts values(?,?,?)',('chunk4','b','投我 永以为好'))
 c.execute('insert into article_chunks values(?,?)',('b:article:4','chunk4'))
 c.execute('insert into article_chunks values(?,?)',('b:article:2','chunk4'))
 c.commit();c.close();before=hashlib.sha256(db.read_bytes()).hexdigest()
 api={'DB':db,'norm':lambda s:s,'tokens':lambda s:s}
 result=search(api,{'dimensions':{'主题':['友情'],'情感':['喜悦'],'用途':['人际交往']},'cues':['相知','相悦'],'query':'喜欢，要怎么表达？'})
 assert result['hits'][0]['id']=='b:article:1'
 assert '主题' in result['hits'][0]['matchedDimensions']
 fallback=search(api,{'dimensions':{'主题':['友情'],'情感':['喜悦']},'cues':['投我','永以为好'],'query':'喜欢，要怎么表达？'})
 assert [x['id'] for x in fallback['hits']]==['b:article:4'],'书籍标签可带回未逐篇标注的相关原文，但不能混入邻接文章'
 assert fallback['hits'][0]['matchedDimensions']=={}
 assert '主题' in fallback['hits'][0]['bookDimensions']
 night=search(api,{'dimensions':{'主题':['友情'],'场景':['月夜']},'cues':['故人'],'query':'月夜如何表达想念？'})
 assert [x['id'] for x in night['hits']]==['b:article:2'],'场景检索不能以情感标签为先决条件'
 spring=search(api,{'dimensions':{'主题':['山水'],'场景':['春景']},'cues':[],'query':'春天的山水怎么形容？'})
 assert spring['hits'][0]['id']=='b:article:3'
 excluded=search(api,{'dimensions':{'场景':['春景']},'exclude':['b:article:3']})
 assert not excluded['hits']
 unknown=search(api,{'dimensions':{'作者':['不存在的作者']}})
 assert not unknown['hits']
 assert all(len(x['text'])<=450 and x['articleId']==x['id'] for x in result['hits'])
 assert before==hashlib.sha256(db.read_bytes()).hexdigest(),'查询不写入索引'
print('inquiry: 多维标签/无情感标签的主题场景检索/真实ID/排除/字数/未知作者/只读通过')
