# WebUI工作台与B站标签评论

版本v0.3.0。总览集中进入B站、群聊、人设知识、日记、连接模型、电脑、语音、骰子及视频草稿。独立页面沿用同一设置API，精确保存已编辑字段，冲突时保留编辑；无编辑时跟随DSH配置。

## 标签评论

B站工作台“刷B站”可开启scroll.tagCommentEnabled，默认关闭。关键词scroll.tagCommentKeywords默认为DeepSeek，匹配真实视频标签且不区分大小写，不以标题或简介代替标签。scroll.tagCommentMaxPerHour默认1，可调1–10；scroll.tagCommentPrompt可补充表达偏好。

仅在实际自主观看时额外读一次标签，评论只根据取得的简介和官方字幕；模型可不评论。共用原有日额度、写入间隔、温和请求队列和风控冷却；同视频持久去重，未知回执不重发。小时观看/分享限制不变。手动采集、研究预览不会因此自动发公开评论；原评论区@分享沿用原流程避免双发。

## 字体

标题使用思源宋体Heavy，正文为思源黑体Regular/Medium。可将自己的字体放在项目同级fonts目录：SourceHanSerifCN-Heavy-4.otf、SourceHanSansCN-Regular.otf、SourceHanSansCN-Medium.otf。字体不随仓库或Release分发；未安装时回退本机字体。字体原许可为SIL OFL，分发时另行遵守其许可。

源码：public/workspace.html、workspace.js、workspace-theme.css；字段在settings-schema.js；标签评论在src/tag-comment.mjs。验证：npm run test:workspaces、npm run test:tag-comment。
