"""Launch the installed original training UI without deleting its TEMP directory."""
import argparse,os,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--port',type=int,default=9874);a=p.parse_args()
root=Path(a.root).resolve();entry=root/'webui.py'
source=entry.read_text('utf-8')
start=source.index('if os.path.exists(tmp):\n');end=source.index('import site\n',start)
if end-start>1800 or 'delete(path)' not in source[start:end]:raise RuntimeError('Original TEMP cleanup changed; refusing to run it')
source=source[:start]+'# TEMP cleanup disabled by integration launcher.\n'+source[end:]
os.chdir(root);sys.path.insert(0,str(root));sys.argv=[str(entry),'zh_CN']
os.environ.update(language='zh_CN',is_share='False',GRADIO_ANALYTICS_ENABLED='False')
import gradio as gr
original=gr.Blocks.launch
def launch(self,*args,**kwargs):
    kwargs.update(server_name='127.0.0.1',inbrowser=False,share=False)
    return original(self,*args,**kwargs)
gr.Blocks.launch=launch
import config
config.webui_port_main=a.port
# Embedded Python's ._pth ignores PYTHONPATH; explicitly wrap only Gradio children.
import subprocess,re
original_popen=subprocess.Popen
child_launcher=Path(__file__).with_name('native-voice-child.py')
def popen(command,*args,**kwargs):
    if isinstance(command,str) and re.match(r'^"[^"]+" -s (?:tools/(?:subfix_webui\.py|uvr5/webui\.py)|GPT_SoVITS/inference_webui(?:_fast)?\.py)(?: |$)',command):
        command=re.sub(r'^("[^"]+" -s )',lambda m:m[1]+'"'+str(child_launcher)+'" ',command,count=1)
    return original_popen(command,*args,**kwargs)
subprocess.Popen=popen
exec(compile(source,str(entry),'exec'),{'__name__':'__main__','__file__':str(entry)})
