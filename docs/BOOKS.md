# 书库

公开仓库不附带书籍、索引或私人阅读记录。在项目根目录自行创建 `book/未索引/`，只放入有权使用的资料。

```powershell
python scripts/book-library.py index
python scripts/book-library.py search "学习 友情"
```

`index`是明确的人工录入操作；普通聊天检索不会自动摄取未索引资料。生产环境可指定书名选择录入，维护前先备份索引。

TXT/Markdown使用内置文本解析。PDF需要pypdf，DOCX需要python-docx；旧DOC需要匹配的外部转换工具。繁简转换可选OpenCC，具体脚本依赖以解析分支为准。不要把书籍文件扩展名改为TXT当作转换。

索引采用本地SQLite及分类资料，先检索书籍/文章标签，再取原文片段。标签可包含主题、情感、场景、用途与作者。现代译文、注释、整理版本和古籍网站下载内容也可能有独立授权条件，随意公开抓取或重新分发不由MIT源码许可覆盖。
