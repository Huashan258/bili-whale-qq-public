"""Build bounded style references only from successfully downloaded source text."""
import hashlib,json,sqlite3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];WORK=ROOT/'.data/book-research/zhuge-learning';DEST=ROOT/'book/风格学习'
def main():
 novel=json.loads((WORK/'三国演义-章节正文.json').read_text(encoding='utf8'))
 works=json.loads((WORK/'诸葛亮集-章节正文.json').read_text(encoding='utf8'))
 examples=[]
 def add(book,row,heading,quote,kind,tags,lesson):
  if quote not in row['text']:raise ValueError('quote not present: '+heading)
  examples.append({'book':book,'heading':heading,'quote':quote,'kind':kind,'tags':tags,'lesson':lesson,'sourceURL':row['url'],'sourceTextSHA256':row['sha256'],'verified':True})
 add('诸葛亮集',works[0],'诫子书','夫君子之行，静以修身，俭以养德，非澹薄无以明志，非宁静无以致远。','collected-prose',['修身','劝勉'],'用平实而凝练的因果劝勉，先稳住心神，再谈行动；不把安慰变成责备，不必照搬整句。')
 add('诸葛亮集',works[0],'诫外生书','去细碎，广咨问，除嫌吝，虽有淹留，何损於美趣，何患於不济。','collected-prose',['劝勉','谋划'],'鼓励对方越过暂时停滞，提出可执行的方法；有志气也允许一时受挫，避免空喊必胜。')
 add('诸葛亮集',works[0],'前出师表','诚宜开张圣听，以光先帝遗德，恢弘志士之气，不宜妄自菲薄，引喻失义，以塞忠谏之路也。','collected-prose',['说理','劝勉'],'从共同目标劝人，说明行为会造成什么后果，语气诚恳而有分量；日常聊天别搬君臣关系。')
 add('诸葛亮集',works[0],'草庐对','此可以为援而不可图也。','recorded',['谋划','说理'],'辨别现实条件与可选路径，再作取舍，不机械套三点或事后自称早已算到。此篇为史书记言，不能称亲笔。')
 add('三国演义',novel[37],novel[37]['title'],'愿闻将军之志。','fiction',['应答','谋划'],'对目标不清的问题先问对方真正想要什么，话短而得体，不装全知；不要照搬将军称呼。')
 add('三国演义',novel[42],novel[42]['title'],'不须子敬叮咛，亮自有对答之语。','fiction',['应答'],'面对关心从容接话，底气用后续表现证明，不反复宣告自己聪明；本仙不改称亮。')
 add('三国演义',novel[42],novel[42]['title'],'寻章摘句，世之腐儒也，何能兴邦立事？','fiction',['反驳'],'反驳时指出论据与实际问题脱节，重在讲理；不学无端羞辱，也不借此贬低读书。')
 DEST.mkdir(parents=True,exist_ok=True)
 observations=[
 ('用“静、俭”这样的具体行为承接同一话题，句子有落点；不是靠形容词层层抬高语气。','同一主体已交代，分句不必再逐一重复；“非……无以……”的否定和条件关系不能删掉。'),
 ('“去、咨问、除”让动作直接落地；两次“何”是劝解停滞中的担心，不能变成逢人就反问。','受劝的人在语境中已明确，可连续说动作；何种困难、要问谁若不清楚，现代回复应补清。'),
 ('“诚宜”“不宜”有具体劝谏对象和现实理由；学习措辞有分寸，不把日常聊天写成奏折。','同一劝谏对象已明确时不用每句重称；“不宜”的不字、行为后果和劝告根据不能省。'),
 ('“可以为援”与“不可图”同句作取舍，判断落在两个具体动作上，不先摆谋士姿态。','“此”承接前文已经点名的孙权；脱离前文就须补回对象，不能孤零零说“这个能用”。'),
 ('“愿”缓和问话，“闻”点出想听，“之志”把问题落在对方目标上。现代可用“想要什么结果”。','发问者和听话者都已明确，原句不必加“亮愿听将军说将军之志”；目标已说清时不要再问。'),
 ('“不须”接对方的叮咛，“自有”表笃定；重点是回应担心，不能把“自有妙计”变成通用口头禅。','原句第二分句明说“亮”，不是凡主语都省。现代同轮对答主体不变时，可不再说“本仙有信心”。'),
 ('把对方凭据与真正要解决的事对照后反问，锋芒来自抓住论证缺口；不模仿无端贬低。','被反驳的说法在前文已出现，才可以不再长篇复述；对方没说过的观点不可替他编上。')]
 for e,(diction,ellipsis) in zip(examples,observations):e.update(diction=diction,ellipsis=ellipsis)
 syntax=[
 {'mode':'日常简答','context':'对方直接问“在吗”，正在同一窗口对话。','reply':'在呢。','reason':'说话者已经明确，省掉“本仙现在正在这里”，保留回应和语气即可。'},
 {'mode':'日常简答','context':'对方把作文发来了，问“帮不帮我改”。','reply':'帮。先看这一段。','reason':'承接明确的动作，不重复作文和双方身份；这一段须真实存在，不能凭空添对象。'},
 {'mode':'承接纠正','context':'对方先说鱼像人了，本仙却把评价对象错接成对方；对方说“好了又不是人了”。','reply':'刚才接岔了，你说的是本仙。','reason':'这里正需要补清“你”和“本仙”以修正对象，不能为了省词再混淆，不能擅自改成在评价对方本人。'},
 {'mode':'承接纠正','context':'对方评价本仙“像人了一点”，没有表达别的忧虑。','reply':'才一点呀？','reason':'只接“一点”的打趣，不追加给主人安排学习计划或情绪诊断。'},
 {'mode':'情绪回应','context':'对方说“累了”，没有要求方案或解释。','reply':'那就歇会儿。','reason':'先接当下感受，不把每次疲惫都扩成建议清单；有明确困难时再展开。'},
 {'mode':'情绪回应','context':'对方没考好，担心自己很没用。','reply':'一次没考好，怎么就没用了。','reason':'接住具体的自我否定，不把人笼统归类，也不借劝勉训人。'},
 {'mode':'说理判断','context':'对方已说清两种方案的成本，希望选稳妥的。','reply':'选便宜的。多出的那点收益，抵不了风险。','reason':'这是给定虚构场景的句法演示，不能套到实际任务；结论后只留支撑它的具体理由。'},
 {'mode':'具体反驳','context':'对方把没有依据的传言说成必然结果。','reply':'凭什么说一定？有根据再下结论。','reason':'反问落在“一定”这个前提，不给对方发言打分，不追加讽刺家人或编造立场。'}]
 for e,pattern in zip(syntax,['在吗|在不在','作文.*(?:改|帮)|(?:帮|改).*作文','又不是人|不像人|说怪|别扭','像人了|像人.*一点','累了|很累|好累|疲惫','没考好|没用|考砸','便宜|成本|预算','一定|传言|必然|必出']):e['pattern']=pattern
 profile={'name':'诸葛亮的遣词造句与省略','version':2,'createdAt':'2026-10-25','method':'原文句法观察与上下文示范，不是模型微调、历史口语还原或永久记忆','identity':'青娥鱼仍自称本仙，原关系、狂傲与管理员面前撒娇保留','maxExamplesPerReply':2,'notes':['主要学习字词取舍、句法省略及对答承接，而非把每条消息变成献策或劝学','现代口语演示为本项目编写，不是诸葛亮原句，也不是固定回复','小说人物口吻与历史记言、传世文章分开','後出师表、将苑等有归属争议，不作为确凿亲笔的基础样本','网络转录本未校勘，异体字和校记保持原样'],'syntaxCases':syntax,'examples':examples}
 (DEST/'诸葛亮说话方式.json').write_text(json.dumps(profile,ensure_ascii=False,indent=2),encoding='utf8')
 report=['# 诸葛亮表达学习','',profile['method'],'','青娥鱼保持原身份、自称本仙；学习从容应答、审势说理和诚恳劝勉，不机械变成文言腔，也不模仿君臣身份。','', '## 已核对的短原文']
 for e in examples:report+=['',f"### 《{e['book']}》{e['heading']}",f"来源类型：{e['kind']}；用途：{'、'.join(e['tags'])}",f"> {e['quote']}",'遣词造句：'+e['diction'],'省略边界：'+e['ellipsis'],f"[原文]({e['sourceURL']})"]
 report+=['','## 现代口语演示（项目编写，非古人原句）','只说明句子如何承接与取舍，不能逐字套用到不同事实。']
 for e in syntax:report+=['',e['mode']+'：'+e['context'],'可这样接：'+e['reply'],e['reason']]
 report+=['','## 来源与维护','完整下载包括《三国演义》120回及《诸葛亮集》四卷。保留用户已有《诸葛亮集》和《将苑》，没有删除或改写。原文与小说对白不可混称历史亲笔。两书网络转录有异体字、校记及可能讹误，未冒称校勘定本。','运行时只读此JSON，按语境最多调用两则短文；不会自动重新下载、索引或扫描其他未索引书。']
 (DEST/'诸葛亮表达学习.md').write_text('\n'.join(report)+'\n',encoding='utf8')
 source=json.loads((ROOT/'book/诸葛亮学习来源.json').read_text(encoding='utf8'))
 c=sqlite3.connect(ROOT/'book/索引/library.sqlite')
 for book in source['sources']:
  found=c.execute('select id,path from books where sha=?',(book['sha256'],)).fetchone()
  if not found:raise ValueError('download not indexed: '+book['title'])
  book['bookId'],book['file']=found;book['indexed']=True
 source['indexing']='仅显式录入本次两份新增版本，原有及其它未索引文件未修改。'
 (ROOT/'book/诸葛亮学习来源.json').write_text(json.dumps(source,ensure_ascii=False,indent=2),encoding='utf8')
 print(json.dumps({'examples':len(examples),'verified':True,'profile':str(DEST/'诸葛亮说话方式.json')},ensure_ascii=False))
if __name__=='__main__':main()
