"""生成图标（托盘 + 安装包）。

输出：
  electron/icon.png   64×64   托盘/非 Windows
  electron/icon.ico   多尺寸  Windows 托盘
  build/icon.ico      多尺寸  electron-builder 的安装包图标
  build/icon.png      512×512 商店页/宣传用

画法：粉→紫的竖向渐变圆 + 白色八分音符 + 右侧两道「在唱」的声波弧。
用 4× 超采样再缩，边缘不会毛。
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SIZE = 1024  # 超采样
ROOT = Path(__file__).resolve().parent.parent
TO_ELECTRON = ROOT / "electron"
TO_BUILD = ROOT / "build"

ICO_SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

# ---- 渐变圆 ----------------------------------------------------------------
top = np.array([255, 143, 177])  # 粉
bottom = np.array([139, 122, 255])  # 紫
yy = np.linspace(0, 1, SIZE)[:, None]
grad = (top[None, None, :] * (1 - yy[..., None]) + bottom[None, None, :] * yy[..., None]).repeat(SIZE, axis=1)
r, g, b = grad[..., 0], grad[..., 1], grad[..., 2]

circle = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(circle).ellipse((16, 16, SIZE - 16, SIZE - 16), fill=255)

img = Image.merge("RGBA", (Image.fromarray(r.astype("uint8")), Image.fromarray(g.astype("uint8")),
                           Image.fromarray(b.astype("uint8")), circle))

d = ImageDraw.Draw(img)
W = (255, 255, 255, 255)

# ---- 八分音符（符头 / 符干 / 符尾）------------------------------------------
d.ellipse((250, 590, 470, 760), fill=W)             # 符头
d.rounded_rectangle((432, 210, 490, 700), radius=24, fill=W)  # 符干
d.polygon([(490, 210), (700, 300), (700, 430), (490, 360)], fill=W)  # 符尾

# ---- 两道声波弧（右边，「她正在唱」）---------------------------------------
for cx, radius, width in ((640, 150, 26), (650, 220, 26)):
    box = (cx - radius, 470 - radius, cx + radius, 470 + radius)
    d.arc(box, start=-50, end=50, fill=(255, 255, 255, 200), width=width)

# ---- 圆边高光 --------------------------------------------------------------
d.ellipse((16, 16, SIZE - 16, SIZE - 16), outline=(255, 255, 255, 90), width=12)

TO_ELECTRON.mkdir(parents=True, exist_ok=True)
TO_BUILD.mkdir(parents=True, exist_ok=True)

png64 = img.resize((64, 64), Image.LANCZOS)
png64.save(TO_ELECTRON / "icon.png")
print("wrote", TO_ELECTRON / "icon.png")

img.save(TO_ELECTRON / "icon.ico", format="ICO", sizes=ICO_SIZES)
print("wrote", TO_ELECTRON / "icon.ico")

img.resize((256, 256), Image.LANCZOS).save(TO_BUILD / "icon.png")
print("wrote", TO_BUILD / "icon.png")

img.save(TO_BUILD / "icon.ico", format="ICO", sizes=ICO_SIZES)
print("wrote", TO_BUILD / "icon.ico")
