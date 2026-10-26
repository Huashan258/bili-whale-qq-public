# DSH插件

此插件把上级项目的业务挂入DSH宿主，并可监督WebUI与SnowLuma。插件及业务代码一起使用，不能只复制本目录。

1. 安装兼容的DSH，并在目标profile注册本目录的本地bundle，挂载声明见 `cordis.patch.yml`；安装方法以所用DSH版本为准。
2. 本地路径指向实际的 `dsh-plugin/`，确保宿主能加载插件与所需peer依赖。
3. 在项目根目录准备自己的 `config.json`、QQ接入和B站登录。
4. 插件默认关闭且预演开启。检查配置后逐项启用QQ、WebUI或巡检。

`dataDir`应与既有业务实例一致，不能借改目录绕过锁。独立Agent与DSH二选一。更换机器时不能复用旧机活动PID和锁；先停止旧实例并核验状态。

WebUI发现DSH后跟随其配置。“让位”代表已有实例占用业务，不要直接反复杀进程。DSH配置支持volatile热更新；部分代码更新仍需重新加载宿主插件。

代码采用根目录MIT许可，DSH与SnowLuma本体遵守各自许可和服务条款。
