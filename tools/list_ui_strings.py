"""把 UI 里需要翻译的中文字面量按文件列出来（只列，不改）。"""
import glob
import re

PAT = re.compile(r"""(["'`])([^"'`\n]*[\u4e00-\u9fff][^"'`\n]*)\1""")

want = ["src/ui/hud.ts", "src/songpack/mood.ts", "src/ui/importer.ts", "src/ui/camPanel.ts", "src/main.ts"]
for f in want:
    text = open(f, encoding="utf-8").read()
    seen = []
    for m in PAT.finditer(text):
        s = m.group(2).strip()
        if s and s not in seen:
            seen.append(s)
    print(f"\n=== {f}（{len(seen)} 条）===")
    for s in seen[:80]:
        print("  " + s.replace("\n", " "))
