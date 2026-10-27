"""Exercise launch wrappers without loading models or running Gradio servers."""
import os,runpy,sys,tempfile,types,subprocess
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
calls=[]
class Blocks:
    def launch(self,**kwargs):return kwargs
sys.modules['gradio']=types.SimpleNamespace(Blocks=Blocks)
sys.modules['config']=types.SimpleNamespace()
subprocess.Popen=lambda command,*args,**kwargs:calls.append(command)
with tempfile.TemporaryDirectory(prefix='voice-launch-test-') as folder:
    root=Path(folder)
    (root/'webui.py').write_text('''import os
tmp='existing-materials'
if os.path.exists(tmp):
    delete(path)
import site
from subprocess import Popen
Popen('"python.exe" -s GPT_SoVITS/inference_webui.py "zh_CN"',shell=True)
Popen('"python.exe" -s tools/uvr5/webui.py "zh_CN" True 1 2',shell=True)
Popen('"python.exe" -s GPT_SoVITS/s2_train.py --config "config.json"',shell=True)
assert gr.Blocks().launch(server_name='0.0.0.0',share=True)['server_name']=='127.0.0.1'
'''.replace("assert gr.","import gradio as gr\nassert gr."),encoding='utf-8')
    sys.argv=['launcher','--root',str(root),'--port','9987']
    runpy.run_path(str(repo/'scripts/native-voice-webui.py'),run_name='__main__')
    assert all('native-voice-child.py' in cmd for cmd in calls[:2])
    assert 'native-voice-child.py' not in calls[2]
    assert sys.modules['config'].webui_port_main==9987
    target=root/'subfix_webui.py'
    target.write_text('''import gradio as gr
import sys
assert sys.argv[1:]==['--load_list','素材.list']
assert gr.Blocks().launch(server_name='0.0.0.0',share=True)=={'server_name':'127.0.0.1','share':False,'inbrowser':False}
assert __name__=='__main__'
''',encoding='utf-8')
    sys.argv=['child',str(target),'--load_list','素材.list']
    runpy.run_path(str(repo/'scripts/native-voice-child.py'),run_name='__main__')
    os.chdir(repo)
print('Native UI wrappers pass: preserve TEMP, wrap only Gradio children, explicit loopback despite isolated Python, preserve tool arguments.')
