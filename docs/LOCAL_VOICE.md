# 本地GPT-SoVITS

GPT-SoVITS直接从文字合成语音，不需要先调用云端TTS再变声。使用者自行准备兼容运行时、基础模型、目标权重和有权使用的参考音频。

## 配置

| 字段（位于chat.voice） | 说明 |
| --- | --- |
| `provider` | 选择 `gpt-sovits` |
| `localApiUrl` | 默认 `http://127.0.0.1:9880`，仅本机HTTP |
| `localInstallDir` | 含runtime/python.exe、api_v2.py和推理配置的Windows整合包目录 |
| `localReferenceAudio` | API所在机器可读取的参考WAV，时长需符合模型要求 |
| `localPromptText` | 参考音频准确原文，不是情绪指令 |
| `localPromptLanguage`、`localTextLanguage` | 参考与合成语言，如zh |
| `localAutoStart` | DSH预加载与监督恢复，合成时也可自动启动 |
| `localTimeoutSec` | 排队与合成总时限，默认180秒 |
| `localNormalizeLoudness` | 默认false，不做目标响度归一化 |
| `localGainDb` | 默认0，范围0～20；独立增益并软限峰 |

公开示例的安装目录、参考音频与原文为空，自动启动关闭。不要使用其他人的私人配置。

## 启动与试听

1. 在整合包的GPT_SoVITS/configs/tts_infer.yaml选择实际权重、设备、版本与精度。
2. 在本项目完整设置填写上述字段并保存。
3. 点击“启动本地语音API”和“检查语音服务”，或执行 `npm run voice:local`。
4. 生成试听，不会发送QQ群或调用百炼。

DSH运行时，试听复用其实际语音发送器preview方法。模块过旧会明确报错，不改走独立链路。生产record和试听使用同一处理函数；诊断记录增益数值，不保存参考文字。

## 生命周期

DSH预加载不等待第一条语音，也不阻塞QQ连接。监督器定期检测、失败退避、复用启动锁与已有API。卸载DSH只停止监督，不强制终止独立模型进程。

WebUI与DSH共享推理文件锁，初期并发1。合成失败且尚未发送时可回文字；QQ回执未知时不重发语音。发送成功后仍遵守表情概率和同图间隔。

当前整合包启动方式按Windows实现，Linux或其他API变体须另行适配。服务仅绑定回环地址，不要将缺少完整认证隔离的模型管理API直接开放到公网。
