# Fonts for generated images

`src/app/opengraph-image.tsx` draws the link-preview card with DM Sans, the
site's typeface. The image renderer reads TTF, not the WOFF2 the site ships, and
cannot pick a weight from a variable font, so these are static instances of
`@fontsource-variable/dm-sans` (latin, weights 800 and 500), made with:

```bash
pip install fonttools brotli
python - <<'PY'
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
for w in (800, 500):
    f = TTFont("node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2")
    font = instancer.instantiateVariableFont(f, {"wght": w})
    font.flavor = None
    font.save(f"assets/fonts/dm-sans-{w}.ttf")
PY
```

Licensed under the SIL Open Font License 1.1 (`OFL.txt`). They are read at
build time only and never served.
