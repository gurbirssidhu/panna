"""Icons for the desktop and iOS builds, drawn with the same code as the Android launcher icon (make_icon.py).

  python3 tools/make_platform_icons.py

writes desktop/build/icon.png (Windows), desktop/build/icons/ (Linux, 16-512 px), desktop/build/icon-mac.png (macOS: the usual margin around the
rounded square) and the 1024 px iOS App Store icon (opaque, square: iOS rounds the corners itself).
"""
import os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
src = open(os.path.join(HERE, 'make_icon.py')).read()
exec(src[:src.index('\nres=')])  # the drawing functions only, not the Android export below them

os.makedirs(os.path.join(ROOT, 'desktop', 'build'), exist_ok=True)
legacy(1024).save(os.path.join(ROOT, 'desktop', 'build', 'icon.png'))
icons = os.path.join(ROOT, 'desktop', 'build', 'icons')  # Linux: one file per size of the hicolor theme
os.makedirs(icons, exist_ok=True)
for n in (16, 24, 32, 48, 64, 128, 256, 512):
    legacy(n).save(os.path.join(icons, f'{n}x{n}.png'))

mac = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
mac.alpha_composite(legacy(824), (100, 100))  # Apple's grid: an 824 px body on a 1024 px canvas
mac.save(os.path.join(ROOT, 'desktop', 'build', 'icon-mac.png'))

ios_dir = os.path.join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset')
if os.path.isdir(ios_dir):
    sq = Image.new('RGBA', (1024, 1024))
    sq.alpha_composite(bgl(1024))
    sq.alpha_composite(fg(1024))
    sq.convert('RGB').save(os.path.join(ios_dir, 'AppIcon-512@2x.png'))
print('icons written')
