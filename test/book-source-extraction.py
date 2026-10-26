import runpy
api=runpy.run_path('scripts/fetch-classics-diancang.py')
p=api['Body']();p.feed('<div id="content"><p>【原文】</p><p>子曰：学而时习之。</p><p>【注释】</p><p>解释文字</p><p>【译文】</p><p>现代翻译</p></div><p>广告</p>')
text,_=api['original_only'](''.join(p.parts));assert text=='子曰：学而时习之。'
text,_=api['original_only']('【原文】甲古文。【注释】甲注释。【原文】乙古文。【译文】乙翻译。')
assert text=='甲古文。\n\n乙古文。'
text,_=api['poetry_original']('关雎\n\n关关雎鸠，在河之洲。\n\n【注释】\n\n解释内容\n\n【译文】\n\n翻译内容\n\n葛覃\n\n葛之覃兮，施于中谷。\n\n【注释】\n\n另一段解释')
assert '关关雎鸠' in text and '葛之覃兮' in text and '解释' not in text and '翻译' not in text
assert text.count('章 ')==2
text,_=api['poetry_original']('駉駉牡马，在坰之野。\n\n【注释】\n\n现代解释\n\n【译文】\n\n现代翻译','駉')
assert '在坰之野' in text and '现代' not in text
assert api['strip_footnotes']('子曰［1］。\n\n［1］注释。\n\n学而。')=='子曰。\n\n学而。'
text=api['clean_poetry_sections']('第1章 小宛\n\n完整正文。\n\n第2章 小 宛\n\n第3章 游 女\n\n摘句。\n\n第4章 宴请宾客\n\n摘句。')
assert text.count('章 ')==1 and '完整正文' in text and '摘句' not in text
print('Book source extraction passed: public body only, multiple originals/poems, notes/translations excluded.')
