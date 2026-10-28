# v0.3.0 维护入口

- [工作台与标签评论](WEBUI_WORKSPACES.md)
- [Windows本机助手](COMPUTER_ASSISTANT.md)
- [剧本阅读与临时筛选](SCRIPT_READER.md)
- [骰子接口与数据](TRPG.md)
- [公开版范围](PUBLIC_RELEASE.md)

## 架构

src/server.mjs是仅回环监听的WebUI，src/chat.mjs是DSH/独立Agent共用QQ入口。settings-schema.js定义前后端字段。骰子优先使用相邻airunning，否则integrations/airunning子模块；运行数据全部保留在选中的airunning。

DSH中原生ESM依赖有缓存，修改后应更新对应导入版本并核对/api/whale/status，而非只看页面字段。当前replySelection.version18、diceScriptReader/diceStructuredTurns=true；computerControl.version2。保存设置不应覆盖未编辑字段。

## 测试和更新

先npm test，再按功能运行package.json中的专项测试。测试只用临时目录和模拟接口，不实发QQ/B站。骰子内核运行npm test，应33项通过。发布前运行npm run test:public-release。

更新前另行备份config.json、.data、书库、日记、表情、NPC记忆及剧本。使用Git时执行git pull后git submodule update --init --recursive；相邻airunning优先部署需另更新它。Release的完整源码ZIP已包含锁定骰子源码；GitHub自动Source code压缩包不会展开子模块。

公开版只发布MIT源码、通用SVG、测试和通用文档；无私人历史、账号素材、聊天、模型权重或字体。新增功能的自动发布和本机访问开关在示例中必须默认关闭。
