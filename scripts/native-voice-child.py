"""Run an existing Gradio tool with explicit local-only launch defaults."""
import sys,runpy
from pathlib import Path
target=Path(sys.argv[1]).resolve()
sys.argv=sys.argv[1:]
sys.path.insert(0,str(target.parent))
exec(Path(__file__).with_name('voice-ui-sitecustomize.py').read_text('utf-8'))
runpy.run_path(str(target),run_name='__main__')
