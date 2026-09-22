"""Build the CJK font files in web/public/fonts/ for pdf-lib embedding.

Used for:
  LXGWWenKaiTC-Regular.ttf  (primary Chinese font, static TTF, OFL, no Reserved Font Name)
  NotoSansTC-Regular.ttf    (fallback, from the Noto Sans TC variable font)

Why not ship the official OTF: @pdf-lib/fontkit cannot subset CID-keyed CFF
fonts (MuPDF/Acrobat reject the result), and its TrueType subsetter writes
short `loca` offsets, which corrupts every glyph whose data length is odd
(the official LXGW WenKai TC file has ~12,800 of them).
So we (1) instance a variable TTF at wght=400 (skipped for static fonts), (2) keep only the Unicode
ranges Traditional Chinese academic text needs, (3) pad every glyph to a
4-byte boundary, (4) fix the name table. Result: Noto ~5.9 MB, LXGW WenKai TC ~ see README; OFL.

usage:
    pip install fonttools
    python scripts/build-font.py NotoSansTC-VF.ttf public/fonts/NotoSansTC-Regular.ttf
    python scripts/build-font.py LXGWWenKaiTC-Regular.ttf public/fonts/LXGWWenKaiTC-Regular.ttf

Sources:
  https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/TTF/Subset/NotoSansTC-VF.ttf
  https://github.com/lxgw/LxgwWenkaiTC/releases/download/v1.522/LXGWWenKaiTC-Regular.ttf

Liberation Serif (Latin) is shipped unmodified: its glyphs are already even
length, and its Reserved Font Name "Liberation" forbids modified copies.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont

UNICODES = ",".join([
    "U+0000-00FF", "U+0100-024F", "U+02B0-02FF", "U+0370-03FF",          # Latin, Greek
    "U+2000-206F", "U+2070-209F", "U+20A0-20CF", "U+2100-214F",          # punctuation, super/subscripts, currency, letterlike
    "U+2150-218F", "U+2190-21FF", "U+2200-22FF", "U+2300-23FF",          # numerals, arrows, math
    "U+2460-24FF", "U+2500-257F", "U+25A0-25FF", "U+2600-26FF",          # enclosed, box drawing, shapes
    "U+2E80-2EFF", "U+3000-303F", "U+3100-312F", "U+31A0-31BF",          # radicals, CJK punctuation, bopomofo
    "U+3200-32FF", "U+3300-33FF", "U+4E00-9FFF", "U+F900-FAFF",          # enclosed CJK, compat, unified ideographs
    "U+FE10-FE1F", "U+FE30-FE4F", "U+FE50-FE6F", "U+FF00-FFEF",          # vertical forms, compat forms, fullwidth
])


def main(src: str, dst: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        static = Path(tmp) / "static.ttf"
        trimmed = Path(tmp) / "trimmed.ttf"
        if "fvar" in TTFont(src, lazy=True):
            subprocess.run([sys.executable, "-m", "fontTools.varLib.instancer", src, "wght=400", "-o", str(static)], check=True)
        else:
            static = Path(src)
        subprocess.run(
            [
                sys.executable, "-m", "fontTools.subset", str(static),
                f"--output-file={trimmed}", f"--unicodes={UNICODES}",
                "--layout-features=", "--no-hinting", "--name-IDs=*", "--glyph-names",
            ],
            check=True,
        )
        font = TTFont(str(trimmed))
        font["glyf"].padding = 4  # the important part: even glyph lengths for the pdf-lib subsetter
        for rec in font["name"].names:
            text = rec.toUnicode()
            if "Thin" in text:
                rec.string = text.replace("Thin", "Regular")
        font.save(dst)

    check = TTFont(dst)
    offsets = list(check["loca"].locations)
    odd = sum(1 for i in range(len(offsets) - 1) if (offsets[i + 1] - offsets[i]) % 4)
    print(f"{dst}: {Path(dst).stat().st_size} bytes, {check['maxp'].numGlyphs} glyphs, glyphs not 4-byte aligned: {odd}")
    assert odd == 0


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
