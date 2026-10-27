"""Loopback-only Gradio for UI subprocesses; training scripts remain untouched."""
import os,sys
from pathlib import Path
if Path(sys.argv[0]).name in ['webui.py','subfix_webui.py','inference_webui.py','inference_webui_fast.py']:
    import gradio as gr
    original=gr.Blocks.launch
    def launch(self,*args,**kwargs):
        kwargs.update(server_name='127.0.0.1',inbrowser=False,share=False)
        return original(self,*args,**kwargs)
    gr.Blocks.launch=launch
