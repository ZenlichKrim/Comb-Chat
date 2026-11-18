"""Generate flat 16x16 placeholder textures so the mod runs before art exists.

Run: python3 tools/gen_textures.py
Each item gets a tinted square with a darker border; blocks get a snow-noise look.
"""
import json, os, struct, zlib

ITEMS = {
    "wool_hat": (222, 232, 242), "wool_sweater": (210, 224, 238), "wool_pants": (198, 212, 230),
    "valenki": (170, 150, 130), "ice_lantern": (168, 200, 232), "snowman_small": (240, 246, 252),
    "artifact_shard": (150, 220, 255), "frost_ward": (110, 170, 220), "storm_eye": (90, 140, 200),
    "winter_heart": (200, 230, 255), "chilling_blade": (180, 210, 240), "transform_wand": (170, 150, 220),
    "soap": (240, 240, 220), "medicine": (200, 120, 120), "herbal_tea": (140, 190, 140),
    "tea_leaf": (90, 140, 90), "winter_kiss_sample": (220, 200, 240), "yeti_fur": (235, 240, 245),
}

def png(path, pixels):
    w = len(pixels[0]); h = len(pixels)
    raw = b"".join(b"\x00" + b"".join(struct.pack("4B", *px) for px in row) for row in pixels)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(data)

def item(path, rgb):
    px = []
    for y in range(16):
        row = []
        for x in range(16):
            border = x in (0, 15) or y in (0, 15)
            shade = 0.78 if border else (1.0 if (x + y) % 7 else 0.93)
            row.append((int(rgb[0] * shade), int(rgb[1] * shade), int(rgb[2] * shade), 255))
        px.append(row)
    png(path, px)

def block(path, rgb):
    px = []
    for y in range(16):
        row = []
        for x in range(16):
            n = ((x * 7 + y * 13) % 9) / 9.0 * 0.12
            row.append((int(rgb[0] * (0.88 + n)), int(rgb[1] * (0.88 + n)), int(rgb[2] * (0.9 + n)), 255))
        px.append(row)
    png(path, px)

base = os.path.join(os.path.dirname(__file__), "..", "src", "main", "resources", "assets", "winter", "textures")
for name, rgb in ITEMS.items():
    item(os.path.join(base, "item", name + ".png"), rgb)
for name in ["coffee_snow","coffee_coal","coffee_diamond","coffee_wool","coffee_rotten_flesh","coffee_ender_pearl",
             "coffee_iron","coffee_paper","coffee_gunpowder","coffee_apple","coffee_gold","coffee_emerald",
             "coffee_lapis","coffee_redstone","coffee_glowstone","coffee_bone","coffee_string","coffee_leather",
             "coffee_feather","coffee_clay","coffee_slime","coffee_honey","coffee_sugar","coffee_tea",
             "coffee_ice","coffee_plain"]:
    item(os.path.join(base, "item", name + ".png"), (120, 90, 70))
for name, rgb in {"dense_snow": (236, 242, 250), "hot_spring": (120, 190, 200), "snow_globe": (200, 230, 250)}.items():
    block(os.path.join(base, "block", name + ".png"), rgb)
item(os.path.join(base, "icon.png"), (168, 200, 232))
print("textures written to", base)
