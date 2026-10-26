// 浏览器和服务端共用字段定义；新增字段必须明确类型和范围。
export const sections = {
  runtime: 'DSH 运行', llm: '模型与采集', qq: 'QQ 连接', chat: '人设与群聊',
  memory: '记忆与长文', shield: '防护与用量', scroll: '刷 B 站', share: '分享与评论巡检',
  bili: 'B 站与主人 UP', guard: '发布闸门', whale: '深读工具',
}
export const fields = []
const add = (section, path, label, type, value, min, max, hint = '') => fields.push({ section, path, label, type, value, min, max, hint })
const b = (s,p,l,v=true,h='') => add(s,p,l,'boolean',v,undefined,undefined,h)
const n = (s,p,l,v,lo=0,hi=100000,h='') => add(s,p,l,'number',v,lo,hi,h)
const t = (s,p,l,v='',h='') => add(s,p,l,'text',v,undefined,undefined,h)
const a = (s,p,l,v=[],h='') => add(s,p,l,'list',v,undefined,undefined,h)
const long = (s,p,l,h='') => add(s,p,l,'long','',undefined,undefined,h)
const secret = (s,p,l) => add(s,p,l,'secret','',undefined,undefined,'留空保留原凭据；支持 env:变量名。')
b('runtime','runtime.enabled','DSH 插件启用',false,'由 DSH 宿主管理；独立 Agent 不读取此开关。')
b('runtime','runtime.dry','DSH 预演模式',true,'开启后 DSH 不实发；独立 Agent 使用启动参数 --dry。')
b('runtime','runtime.qqEnabled','DSH QQ 通道',false)
b('runtime','runtime.webUi','DSH 自动启动 Node WebUI',false,'由 DSH 托管；退出后自动拉起。已有 WebUI 时复用。')
n('runtime','runtime.webUiPort','Node WebUI 端口',7788,1,65535)
n('runtime','runtime.scrollMinutes','DSH 刷站检查间隔（分钟）',6,6,1440)
t('llm','llm.provider','模型提供方','deepseek','deepseek / openai / workbuddy / none')
t('llm','llm.baseUrl','模型 API 地址','https://api.deepseek.com')
t('llm','llm.model','模型名称','deepseek-chat')
secret('llm','llm.apiKey','API Key')
b('llm','vision.enabled','QQ 图片识别',true,'读取当前群聊或私聊消息中的图片，再按人设回复。图片发往现有模型服务，不保存图片文件；链接过期、超时或失败会如实说明。')
t('llm','vision.model','QQ 看图模型','', '沿用当前API地址和密钥；DeepSeek默认使用deepseek-flash，其他服务默认沿用聊天模型（需支持图片）。不影响日常聊天模型。')
n('llm','vision.maxImages','每条消息最多识别图片数',3,1,3,'最多3张，每张8MB；超出部分明确说明未读取。')
add('llm','vision.detail','图片读取精度','select','auto',undefined,undefined,'自动精度适合截图文字；低精度适合简单表情和场景，花费更少。')
fields.at(-1).options=[{value:'auto',label:'自动（推荐）'},{value:'low',label:'低精度'}]
n('llm','llm.requestTimeoutSec','模型请求总时限（秒）',60,10,180,'一次模型调用的全部尝试共用此时限；超时后必回模式发送本地回执，继续处理下一条。长文较慢时可调高。')
n('llm','llm.maxRetries','模型失败最多重试次数',2,0,3,'仅网络故障、408、429及5xx重试；退避等待计入总时限。密钥错误或接口返回HTML不会反复请求。')
n('llm','llm.temperature','审片温度',1.3,0,2)
n('llm','llm.maxCharsSubtitle','字幕采集字符数',6000,0,100000)
n('llm','llm.maxCharsDanmaku','弹幕采集字符数',1200,0,20000)
n('llm','llm.maxComments','热评采集条数',15,0,100)
t('qq','qq.onebotHttp','OneBot HTTP','http://127.0.0.1:3000')
t('qq','qq.wsUrl','OneBot WebSocket','ws://127.0.0.1:3001','连接地址修改后需重启当前聊天进程。')
secret('qq','qq.accessToken','HTTP Token'); secret('qq','qq.wsToken','WS Token')
a('qq','qq.groupIds','群号',[],'每行一个或逗号分隔；保存时同步聊天白名单。')
b('qq','qq.atAll','分享时 @全体',false); b('qq','qq.sendCard','发送视频卡片',false)
b('chat','chat.enabled','聊天启用')
t('chat','chat.nick','昵称','青娥鱼'); a('chat','chat.aliases','可呼叫的别名')
long('chat','chat.persona','人设正文'); long('chat','chat.taboo','禁忌与边界')
a('chat','chat.admins','管理员 QQ'); a('chat','chat.adminTitles','管理员普通聊天称呼池',[],'仅普通聊天及补话使用；令咒请求临时使用专属称呼，不改变此池。')
t('chat','chat.adminTitle','令咒期间管理员称呼','Master','仅当前消息触发令咒时使用；普通聊天恢复管理员称呼池。')
t('chat','chat.guestTitle','令咒期间路人称呼','魔术师','仅当前消息触发令咒时使用；普通聊天按人设及对方名字称呼。')
b('chat','chat.search.enabled','联网搜索与令咒近期资料读取',true,'普通“某某是谁/介绍某某/人物资料”会先查已配置Wiki，未知作品也探查站内；已有正文不再假称不认识，空网页结果不作十分钟缓存。令咒按相关游戏优先Wiki，继续交叉查B站、多个引擎与YouTube；找到也补查其它来源。核对版本、发布日期、编辑时间，近期结果默认缓存2分钟。B站五视频资料读取保留；网址仅内部证据留存，回答不贴链接。普通背景搜索和用户给定页面仍可实际读公开正文，不执行登录或验证码后内容。')
a('chat','chat.search.priorityWikis','令咒优先游戏Wiki',['fgo.wiki','prts.wiki','wiki.biligame.com/sr','wiki.biligame.com/ys'],'按游戏选择对应Wiki并读正文。内置这四站，可调整顺序或移除；其它站点仍可通过一般网页检索找到。')
b('chat','chat.search.crossCheck','找到资料后继续多源交叉查证',true,'继续补查B站、多个搜索引擎和YouTube；Wiki为优先证据。B站仍读取五个不同视频素材。回答不贴网址，来源留本机后台。')
a('chat','chat.search.engines','令咒网页搜索引擎',['bing','duckduckgo','brave'],'支持bing、duckduckgo、brave；失效会记录并继续其它引擎，不冒称成功。')
b('chat','chat.search.youtube','令咒补查YouTube公开页面',true,'通过搜索引擎检索YouTube公开视频页面；只取得标题/简介时会注明，不能声称看完视频。')
n('chat','chat.search.freshCacheMinutes','近期令咒检索缓存（分钟）',2,0,10,'0不复用完成结果；近期检索刷新页面并核对版本、发布日期及编辑时间，编辑时间不等于活动时间。')
b('chat','chat.deepReply.enabled','所有回复深度思考并联网检索',false,'对已选中的QQ群/私聊、B站私信/评论及分享回复开启模型思考，并在生成前实际检索；不会把所有群消息变成必回。明确资料任务沿用B站五视频流程，日常文字和图片观察用网页检索补充背景。已取得本轮检索结果时不重复搜索；失败或无关不编造事实，不强行引用。用户明确不要联网时遵守；联网总开关仍有效。')
b('chat','chat.learnedStyle.zhugeEnabled','学习诸葛亮的遣词造句与省略',false,'侧重具体用词、直答与反问的分寸、明确主语下的省略和对话承接，减少献策腔、奏表腔和固定套路。按语境提供原文句法观察与现代口语演示，不是固定回复。短句有省略时，可补充三分钟内同一人的两句与本仙实际上一答；上下文设0时仍不补。保留本仙身份、关系、字数和关键否定条件。关闭不删除书籍。')
b('chat','chat.splitReplies','QQ长回复分条发送',true,'群聊和私聊按完整句意分成最多三条文字，间隔约0.8秒；短答、代码和表格保持整条。文字发送完后可按语境另发一个已有表情包。每条分别计入普通60条/分钟，管理员豁免。')
n('chat','chat.splitReplyChars','QQ回复开始分条的字数',90,40,500,'达到此长度才尝试按句末或长句分句边界拆开；找不到自然断点时保持整条，不强截句子。')
b('chat','chat.voice.enabled','群聊短回复使用语音',false,'支持QQ原生音色或外部CosyVoice自定义音色。仅群聊；长文、令咒、检索结果和错误提示使用文字。语音成功后按现有表情库设置选图发送，遵守同图间隔；语音失败或回执不明时不重发、不补文字或表情。')
add('chat','chat.voice.provider','语音提供方','select','qq-native',undefined,undefined,'CosyVoice在云端合成，QQ仅发送音频；原生模式沿用QQ音色。')
fields.at(-1).options=[{value:'qq-native',label:'QQ原生语音'},{value:'cosyvoice',label:'百炼CosyVoice云端语音'}]
secret('chat','chat.voice.apiKey','CosyVoice API Key')
add('chat','chat.voice.region','CosyVoice地域','select','beijing',undefined,undefined,'密钥、工作空间、音色必须在同一地域。')
fields.at(-1).options=[{value:'beijing',label:'华北2（北京）'},{value:'singapore',label:'新加坡'}]
t('chat','chat.voice.workspaceId','CosyVoice Workspace ID','','填写后使用业务空间专属域名；留空使用该地域兼容域名。')
t('chat','chat.voice.model','CosyVoice模型','cosyvoice-v3.5-flash','必须与创建音色时的target_model相同。')
t('chat','chat.voice.voiceId','CosyVoice自定义音色ID','','填百炼创建的voice_id，不能使用QQ原生音色名。')
n('chat','chat.voice.volume','CosyVoice语音音量',50,0,100,'仅用于CosyVoice云端语音和本地试听；50为接口默认值，数值越大声音越响，0为静音。保存后后续生成生效，不改变现有音频文件。')
b('chat','chat.voice.normalizeLoudness','语音响度增强',true,'对实际WAV波形提升音量，峰值限制防削波；仅影响之后生成的CosyVoice音频。')
n('chat','chat.voice.boostDb','语音额外增益（分贝）',0,0,20,'在响度增强之后再提高音量，软限幅控制峰值；10分贝约为3.16倍振幅，峰值较多时实际响度增幅会略低。0关闭额外增益。')
n('chat','chat.voice.loudnessTarget','语音目标响度（dBFS RMS）',-16,-24,-12,'越接近0越响；默认-16，实际增益受峰值限制。音量0仍为静音。')
t('chat','chat.voice.instruction','CosyVoice说话语气','','可修改或留空关闭；汉字按2字符、其他按1字符，上限100；仅支持的模型发送。')
n('chat','chat.voice.maxChars','语音回复最多字数',80,5,200,'只对完整回复判断，超过上限直接发文字，不截断原文。')
n('chat','chat.voice.chance','短回复使用语音的概率',.35,0,1,'0关闭，0.35约35%，1表示符合条件的短回复全部使用语音。')
add('chat','chat.voice.character','QQ 语音音色','select','lucy-voice-xueling',undefined,undefined,'使用QQ原生音色；某个群不支持时自动回退文字。')
fields.at(-1).options=[{value:'lucy-voice-xueling',label:'元气少女'},{value:'lucy-voice-f38',label:'傲娇少女'},{value:'lucy-voice-f36',label:'温柔妹妹'},{value:'lucy-voice-female1',label:'邻家小妹'},{value:'lucy-voice-suxinjiejie',label:'酥心御姐'},{value:'lucy-voice-daji',label:'妲己'},{value:'lucy-voice-f37',label:'文艺少女'},{value:'lucy-voice-f34',label:'书香少女'},{value:'lucy-voice-female2',label:'暖心姐姐'},{value:'lucy-voice-laibixiaoxin',label:'小新'},{value:'lucy-voice-houge',label:'猴哥'},{value:'lucy-voice-lizeyan',label:'霸道总裁'},{value:'lucy-voice-male2',label:'磁性大叔'}]
b('chat','chat.command.enabled','启用令咒请求',true,'以指定前缀开头可跳过本地任务意图限制；至少200字，路人令咒输出上限60000 token，管理员令咒200000 token。保留QQ发送频率、输入长度和B站风控策略；模型服务本身的上限仍有效。')
t('chat','chat.command.prefix','令咒触发前缀','我以令咒命之：','仅匹配当前消息开头，空值禁用。QQ群聊/私聊及B站评论/私信均生效；B站回复保留至少200字，但只发一条：评论最多900字、私信最多500字。')
add('chat','chat.quietHours','静默时段','hours',[2,8],0,23,'填起止两个小时，如 2, 8；清空关闭，可跨午夜。')
b('chat','chat.replyEveryMessage','QQ 收到消息逐条必回',true,'仅适用于QQ白名单群聊和QQ私聊，不包含B站站内私信。每条新消息独立排队回复，包含短句、单字和表情；普通输出每分钟60条，管理员豁免。重复投递和机器人自己的消息不回。')
b('chat','chat.outputRateOnly','自由聊天：普通输出每分钟60条，管理员豁免',true,'普通群友的群聊、私聊、通知和推荐共享60秒窗口，管理员私聊和对管理员的群聊回复不占额度；开启时忽略群/私聊冷却、小时限额和 token 熔断预算。B站限制独立保留。')
n('chat','chat.speakChance','主动接话概率（非必回模式）',0.55,0,1,'仅用于关闭逐条必回后的普通群消息，文字、纯图片和图文共用每群同一份平滑分配；0.6表示每10条普通消息选6条，避免连续刷屏。选中后才识图并生成回复；1为100%、0不主动。@、叫名字、明确任务单独必回，不占普通消息分配。自由聊天限额开关不会覆盖此比例，未选中不会再挂补话。')
n('chat','chat.minGapSec','群聊冷却（秒）',75,0,3600)
n('chat','chat.maxPerHour','每小时发言上限',20,0,1440)
b('chat','chat.quote','引用原消息'); b('chat','chat.catchUp','延迟补话')
n('chat','chat.catchUpSec','补话等待（秒）',45,1,3600)
n('chat','chat.videoRequestCooldownSec','点播视频冷却（秒）',1800,0,86400)
n('chat','chat.private.minGapSec','私聊冷却（秒）',8,0,3600)
n('chat','chat.private.maxPerHour','私聊每小时上限',30,0,1440)
n('chat','chat.private.guestMemoryMinutes','访客记忆保留（分钟）',30,0,1440)
b('memory','diary.autoEnabled','启动补写与跨日自动日记',true,'以文言文抒怀，可引用古籍一句或一段，允许略去当天事件，不列视频链接。每篇至多3000字（标题与正文含标点），不设最低字数。启动后顺序补写有本地记录但缺日记的日期（含当天）；北京时间跨日后为刚结束的一天生成完整日记。已有当天半日版本会保留。后台每分钟检查，失败退避后再试；关闭后不再创建自动任务，正在写的继续完成。')
b('bili','biliInbox.mentionsEnabled','读取视频评论区@提醒并回复',true,'每五分钟检查一页最近七天的真实@提醒，每轮最多处理一条；核对原评论作者和视频后，读取简介/可用字幕再回复原楼层。观看10条/小时、六分钟间隔及全局风控不变；视频暂未读取则保留等待，不编造看过。')
b('memory','diary.publishEnabled','自动投稿日记至B站专栏',false,'每天跨日生成完整日记后自动投稿；历史完整日记也按日期排队，每天只选一篇完整版。已提交不重复投稿，回执不明时停止该篇自动重发。需保持DSH托管WebUI或正式后台运行，审核结果以B站为准。')
n('memory','diary.publishGapMinutes','日记专栏投稿间隔（分钟）',15,2,1440,'历史日记逐篇补发，默认相隔15分钟；与其他B站行动共用温和访问和写入限制。')
t('memory','diary.collectionName','B站日记文集名称','青娥鱼的日记','投稿前自动创建或复用同名文集；已发布日记补归入文集，后续日记直接在文集内投稿。')
n('memory','chat.temperature','闲聊温度',0.8,0.1,2,'建议0.6~1.0；高于1.2容易跑题、语句失控。')
n('memory','chat.longFormTemperature','完整内容回复温度',0.6,0.1,2,'管理员长文或群友明确指定字数时使用，建议0.5~0.8。')
n('memory','chat.shield.longFormMaxOutputTokens','长文输出 token 上限',2400,200,8000)
n('memory','chat.contextMessages','上下文消息条数',14,0,50,'0 或 1 只带当前消息。')
n('memory','chat.historyRestore','启动恢复消息条数',14,0,50,'0 不恢复历史。')
n('memory','chat.historyReplyWindowSec','重启追话窗口（秒）',600,0,86400,'0 不主动追话；启动恢复相关设置在下一次启动使用。')
b('shield','chat.shield.enabled','启用防注入与用量闸门')
b('shield','chat.shield.adminBypass','管理员跳过意图拦截')
b('shield','chat.shield.teaseWhenForced','被呼叫且拦截时固定回话')
for (const [key,label,v,lo,hi] of [
 ['maxInputChars','单条输入截断字符',800,50,8000],['hardMaxChars','单条输入硬上限',2000,100,20000],
 ['maxContextChars','上下文字符上限',2400,200,12000],['maxOutputTokens','路人单次输出 token 上限',260,32,20000],
 ['adminMaxOutputTokens','管理员普通输出 token（自动为路人三倍）',780,96,60000],['adminHardMaxChars','管理员输入硬上限',8000,100,40000],
 ['perCallTokens','单次熔断 token',3000,0,200000],['dailyTokens','每日 token 上限',200000,0,20000000],
 ['guestHourlyTokens','所有路人每小时共享 token 上限',400000,0,20000000],
 ['userWindowSec','单用户统计窗口（秒）',600,60,86400],['userWindowTokens','窗口 token 上限',12000,0,1000000],
 ['userCooldownSec','触发熔断后冷却（秒）',600,0,86400],
]) n('shield',`chat.shield.${key}`,label,v,lo,hi,key === 'guestHourlyTokens' ? '所有非管理员共享最近 60 分钟的输入与输出实际用量；0 不限，重启聊天进程后重新计数。' : '')
Object.assign(fields.find(f=>f.path==='chat.shield.adminMaxOutputTokens'),{readOnly:true,hint:'自动计算：路人普通上限 × 3。修改路人上限后同步变化，不能单独覆盖；路人令咒固定60000，管理员令咒固定200000。'})
a('shield','chat.shield.tease','拦截回话池',[],'每行一句；留空使用运行时默认回话池。')
b('scroll','scroll.enabled','DSH 自动刷 B 站',false,'刷站定时调度由 DSH 提供；独立 Agent 暂无此调度。')
b('scroll','scroll.hourlyReactionEnabled','每小时读十个视频再按选词发群',false,'每轮一小时，分时读取十个不同视频，完成后选弹幕与评论采样中选词总次数最多的发QQ群。只发一个视频；统计失败不当零，进度跨重启保存。本模式发QQ群；开启B站站内私信推送时，同一获选视频也私信至接收UID，共用一个分享额度并按渠道独立记回执。不会发评论区或QQ私聊。')
a('scroll','scroll.reactionKeywords','互动统计选词',['?','？','妈妈'],'每行一个，可随时修改；按字面计数，不作为正则。未进入发送的本小时采样会按新词重算，无需重新访问B站。已开始发送的那条固定，下轮用新词。清空暂停小时比较。')
n('scroll','scroll.danmakuSample','每个视频弹幕采样条数',1000,100,5000,'一次公开弹幕读取，最多取这些条数；不冒称全量互动总数。')
n('scroll','scroll.commentSample','每个视频评论采样条数',20,5,20,'仅一页公开评论；去重并排除机器人自身评论。读取失败的样本不参与完整排名。')
add('scroll','scroll.deliveryMode','分享方式','select','private',undefined,undefined,'私聊分享发到 QQ；评论区 @ 会公开发布 B站评论。')
fields.at(-1).options=[{value:'private',label:'私聊分享（默认）'},{value:'comment',label:'评论区 @'}]
a('scroll','scroll.privateUsers','私聊接收 QQ',[],'留空使用管理员 QQ 名单；可填多个，每行一个。')
b('scroll','scroll.biliPrivateEnabled','有趣的视频也推送至B站站内私信',false,'小时比较和原刷站模式均生效，与QQ渠道独立。继续共用每小时最多分享一个视频、B站访问/写入间隔和风控冷却；回执不明不重复发送。')
a('scroll','scroll.biliPrivateUsers','B站推送接收 UID',[],'留空优先使用B站私信联系人，其次主人UP名单。这里填B站UID，不是QQ号。')
b('scroll','scroll.syncGroups','有趣的视频同步分享至群聊',true)
a('scroll','scroll.groupIds','同步分享群号',[],'留空使用「QQ 连接」配置的全部群号。')
a('scroll','scroll.keywords','搜索关键词'); a('scroll','scroll.tags','偏好题材')
long('scroll','scroll.preferences','视频口味与偏好'); t('scroll','scroll.mentionName','评论 @ 的名字')
n('scroll','scroll.perDay','每日推荐视频上限',3,0,24,'全入口硬限制：滚动一小时最多观看10个、分享1个视频；相邻观看至少6分钟，分享至少1小时。')
n('scroll','scroll.mentionPerDay','每日评论区 @ 上限',10,0,100, '仅评论区 @ 模式使用；私聊分享不占 B站评论额度。')
n('scroll','scroll.maxCandidates','每轮观看视频上限',1,0,1)
n('scroll','scroll.maxAgeDays','候选视频最老天数',3,0,365)
n('scroll','scroll.minDurationSec','最短视频时长（秒）',30,0,36000)
n('scroll','scroll.gapSec','刷站投递间隔（秒）',30,30,3600)
b('scroll','scroll.useDiscover','从热门与排行榜发现',true,'未设置搜索词或题材时使用，避免无关热门挤占题材候选。'); b('scroll','scroll.useMasters','从主人 UP 收集候选')
b('share','share.enabled','独立 Agent 定时分享'); b('share','share.discover','从热门发现'); b('share','share.randomPick','随机挑片')
for (const [key,label,v,lo,hi] of [
 ['everyMinutes','定时分享间隔（分钟）',240,1,10080],['firstDelayMinutes','首次分享延迟（分钟）',10,0,1440],
 ['maxPerDay','每日群分享上限',2,0,1000],['maxAttempts','每轮审片尝试次数',1,1,1],['minScore','推荐评分门槛',14,0,20],
 ['discoverLimit','热门候选数',20,1,100],['temperature','分享温度',1.2,0,2],
 ['biliCommentPerDay','B 站账号每日总评论上限',6,0,10000],['pluginReservePerDay','其他插件预留评论数',0,0,10000],
 ['masterCommentPerDay','每个主人每日评论',1,0,1000],['masterReplyPerDay','每个主人每日回复',3,0,1000],
 ['masterReplyPerVideo','每视频回复上限',2,0,1000],['masterReplyWithinDays','主人评论回复期限（天）',3,0,365],
 ['masterMaxAgeDays','主人视频最老天数',30,0,3650],['biliGapSec','账号评论最小间隔（秒）',120,120,3600],
 ['replyPatrolMinutes','评论巡检间隔（分钟）',5,0,1440],['replyPatrolFirstDelayMinutes','首次巡检延迟（分钟）',5,5,1440],
 ['replyPatrolWithinDays','巡检回复期限（天）',7,0,365],
]) n('share',`share.${key}`,label,v,lo,hi,key === 'replyPatrolMinutes' ? '0 关闭；开启时至少 5 分钟。每轮轮换检查两条视频，每条只读一页。' : '')
a('share','share.blockKeywords','屏蔽关键词'); a('share','share.replyWatchVideos','额外巡检视频 BV 号')
a('share','share.replyFocusVideos','优先接话视频 BV 号',[],'每轮优先轮巡一条关注视频，再轮巡一条其他视频，最多两条；不增加B站访问频率。')
b('share','share.ownVideoReplies','回复自己投稿下的一级评论',false,'仅对已关注且核验UP为登录账号的视频生效；回复近期留言及后续楼层，不把用户评论当成机器人评论。')
b('bili','biliInbox.enabled','B站站内私信自动回复',false,'与QQ私聊独立；只接下面列出的B站UID，每轮最多回复一条；与评论共用温和访问策略。')
a('bili','biliInbox.privateUsers','B站私信联系人 UID',[],'留空使用主人UP名单。仅读取这些会话，不扫描或回复其他人的私信。')
n('bili','biliInbox.pollMinutes','B站私信检查间隔（分钟）',5,5,1440,'接在评论巡检后执行，实际间隔不会短于评论巡检周期。重载/重启不清空间隔。')
n('bili','biliInbox.lookbackHours','初次接入私信回看时长（小时）',48,1,168,'首次只接最近一条未被自己发言覆盖的文本私信；后续按持久游标逐条处理。')
secret('bili','bili.sessdata','SESSDATA'); secret('bili','bili.bili_jct','bili_jct'); secret('bili','bili.buvid3','buvid3')
t('bili','bili.cookie_file','凭据文件路径'); t('bili','bili.dedeUserId','登录账号 UID')
a('bili','bili.watchList','优先观看 BV 号'); a('bili','bili.watchUps','关注的 UP UID')
add('bili','bili.masters','主人 UP 名单','masters',[],undefined,undefined,'JSON 数组：mid、name、autoComment、replyComments；支持新增、删除。')
n('guard','guard.maxSharePerDay','群分享硬上限',3,0,1000)
n('guard','guard.sameVideoCooldownDays','同视频冷却（天）',7,0,365)
n('guard','guard.minScore','最低评分',13,0,20)
b('guard','guard.requireConfirm','要求发布确认'); b('guard','guard.stopOnRiskControl','风控时停止')
t('whale','whale.dir','dsh-bili-whale 目录'); t('whale','whale.ffmpeg','ffmpeg 路径')

// 本地保存时同步 DSH 覆盖层，防止宿主下次重挂写回旧值。
export const overlayMap = {
 'runtime.enabled':'enabled','runtime.dry':'dry','runtime.qqEnabled':'qqEnabled','runtime.scrollMinutes':'scrollMinutes',
 'runtime.webUi':'webUi','runtime.webUiPort':'webUiPort',
 'share.replyPatrolMinutes':'replyPatrolMinutes','scroll.enabled':'scrollEnabled',
 'scroll.keywords':'scrollKeywords','scroll.tags':'scrollTags','scroll.preferences':'scrollPreferences',
 'scroll.perDay':'scrollPerDay','scroll.mentionName':'scrollMention','scroll.maxCandidates':'scrollMaxVideos',
 'qq.groupIds':'groups',
 ...Object.fromEntries(['nick','persona','taboo','aliases','admins','quietHours','speakChance','minGapSec','maxPerHour','temperature','longFormTemperature','contextMessages','historyRestore'].map(k => [`chat.${k}`,k])),
 'chat.shield.longFormMaxOutputTokens':'longFormMaxOutputTokens',
}
