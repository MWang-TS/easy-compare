"""生成 Easy Compare 应用图标（纯 Pillow，无外部素材）。
设计：深蓝圆角底 + 左右双栏 + 中间对比箭头，呼应产品的双栏结构。
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)

S = 1024


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 底板：深蓝渐变（用横向色带模拟）
    for y in range(S):
        t = y / S
        r = int(24 + 12 * t)
        g = int(56 + 22 * t)
        b = int(96 + 34 * t)
        d.line([(0, y), (S, y)], fill=(r, g, b, 255))
    # 裁剪圆角
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=200, fill=255)
    im.putalpha(mask)
    d = ImageDraw.Draw(im)

    # 左右两个面板
    panel_fill = (238, 244, 251, 255)
    rounded(d, (110, 190, 460, 834), 42, panel_fill)
    rounded(d, (564, 190, 914, 834), 42, panel_fill)

    # 面板里的文件行：左绿/红，右对应
    rows = [
        (250, (46, 160, 96, 255), (46, 160, 96, 255)),
        (370, (222, 78, 78, 255), (222, 78, 78, 255)),
        (490, (46, 160, 96, 255), (238, 170, 60, 255)),
        (610, (238, 170, 60, 255), (200, 208, 218, 255)),
        (730, (46, 160, 96, 255), (46, 160, 96, 255)),
    ]
    for y, lc, rc in rows:
        rounded(d, (150, y, 420, y + 46), 18, lc)
        rounded(d, (604, y, 874, y + 46), 18, rc)

    # 中间：三个单向右箭头，明确「源 → 目标」的单向增量备份（Q1-D）。
    # 刻意不用双向箭头，避免被误解为会反向写回源目录或双向删除。
    arrow = (120, 215, 255, 255)
    for cy in (330, 512, 694):
        d.rounded_rectangle((476, cy - 11, 528, cy + 11), radius=8, fill=arrow)
        d.polygon([(528, cy - 34), (562, cy), (528, cy + 34)], fill=arrow)

    return im


im = make()
im.save(os.path.join(OUT, "icon-source.png"))
im.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "128x128@2x.png"))
im.resize((128, 128), Image.LANCZOS).save(os.path.join(OUT, "128x128.png"))
im.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "32x32.png"))
im.resize((256, 256), Image.LANCZOS).save(
    os.path.join(OUT, "icon.ico"),
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

# 前端标题栏左上角也用同一张图，必须跟着一起更新，否则两处图标会不一致。
WEB = os.path.join(os.path.dirname(__file__), "..", "src")
os.makedirs(WEB, exist_ok=True)
im.resize((128, 128), Image.LANCZOS).save(os.path.join(WEB, "icon.png"))
print("ICONS_OK", os.listdir(OUT))
