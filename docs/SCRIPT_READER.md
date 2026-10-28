# 完整剧本阅读与临时筛选

更新：2026-10-28。宿主WebUI地址 `/script-reader.html`，骰子工作台“剧本记录”区提供入口。选择群与剧本，可读进行中、暂停中、结束归档的完整聊天记录；列表不会只保留最近30个归档。

## 阅读方式

- 50/100/200段一页，可从头到尾翻页；全文查找在整份剧本中执行，不只搜索当前页。
- 左侧“显示哪些角色”取消某角色，即暂时隐藏该角色发言。按发送者或NPC归属判断，不会因为别人提到“科比”就把别人的话也隐藏。
- “隐藏 ** 场外注释”依据记录的ooc标记和共用场外检测器判断。
- “隐藏 KP 发言”优先使用记录时保存的真实KP身份；旧记录缺身份时使用开场人物快照和当前KP记录。也可在“本页KP身份”临时指定玩家，仅供页面过滤，不改变真实KP或权限。
- 选择保存在当前标签页的sessionStorage，按群和剧本分别保存；关闭标签页后结束。点“恢复全部”可清空所有筛选和查找。
- 可选择每10秒刷新当前页，默认关闭。自动刷新不会清除筛选。
- “下载完整原文”下载原有聊天记录TXT，包含当前隐藏的条目。下载不应用页面筛选，页面已明确提示。

## 不改变运行状态

阅读接口不调用.log控制，不继续暂停的剧本，不写索引或原文，不改变NPC启停、好感、记忆门控或真实KP设置，也不发QQ消息、不调用模型。记录仍保存在airunning的beginscript与endscript。

旧的匿名“青娥模拟”没有可靠角色标记时，归入“NPC（旧记录未标明角色）”，可单独隐藏。明确带角色名前缀的旧多人回复按行拆开并标记“旧格式识别”；不根据正文中随意提到的人名猜测归属。

新模拟发送前将每位NPC的`npc/reply`元数据随内部发送上下文传递，实际QQ消息格式不变；chat.jsonl新增turns，只含公开角色名和对白，不含好感原因或秘密背景。阅读页可单独筛掉同一条QQ消息里的某个NPC，其他NPC保留。人类记录新增当时的characterName、isKp，避免后来修改KP或.nn导致旧记录身份漂移。

## 实现

- `dice-plugin/script-reader.mjs`：只读索引、受控路径、流式扫描、分页、归属与显示筛选。JSONL读取限定到请求开始时的文件大小；损坏行会显示数量，不覆盖文件。记录量大时扫描全文件计算准确总数，页面只渲染当前页。
- `dice-plugin/public/script-reader.html/css/js`：独立阅读页、临时筛选、查找、分页和可选刷新；全部记录通过textContent渲染，不解释聊天里的HTML或脚本。
- `dice-plugin/scripts.mjs`：记录当时角色名/KP及turns，原TXT与QQ消息正文保持原样。
- `dice-plugin/theatre.mjs`：生成完成后仅把npc/reply交给发送器，元数据不混入公开QQ协议参数。
- 宿主 `src/script-reader.mjs`：使用实际airunning路径和测试隔离路径，校验群白名单。
- 宿主 `src/trpg-scripts.mjs`、`src/qq.mjs`、`src/chat.mjs`：发送前暂存角色归属，兼容自身回声先于HTTP回执到达；相同message_id只存一次，也不丢失结构化归属。

宿主接口：

| GET | 用途 |
| --- | --- |
| `/api/dice/script-library` | 白名单群与全部已索引剧本 |
| `/api/dice/script-reader` | group、id、offset、limit、hidden(JSON数组)、hideOoc、hideKp、kpSpeaker(本页临时KP)、q |
| `/api/dice/script-download` | group、id，下载完整原TXT |

只接受索引中的剧本ID与群，不接受客户端提供任意文件路径；校验目录/文件真实路径，拒绝符号链接或junction越界。开场快照只用于归属识别，不把NPC背景资料返回阅读页。页面的临时KP不参与任何鉴权。

## 验证与加载

`npm test`：33项通过，包括完整分页、超过30份归档、独立NPC筛选、正文提及他人不误删、临时KP、OOC、旧匿名记录、原文件字节不变、越界和结构化模拟。

宿主：`node test/script-reader-host.mjs`、`node test/trpg-scripts.mjs`、`node test/dice-plugin.mjs`，验证真实发送代码路径、回执前自身回声及只读接口，不连接真实QQ，不写真实剧本。

本次运行版本：replySelection.version18，diceScriptReader/diceStructuredTurns=true，骰子与剧本内核query=12；DSH入口hostRevision=20261028-scriptReader2。原生ESM模块在HMR中有缓存，相关宿主导入使用scriptReader=1；以后修改运行中的依赖模块，也需递增相应导入版本并核对实际状态，不以新页面可见代替内核已加载。
