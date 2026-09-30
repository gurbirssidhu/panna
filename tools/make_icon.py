from PIL import Image, ImageDraw, ImageFilter
import sys
from icon_base import bg, lerp
CREAM=(255,253,247); UNDER=(226,240,232); SPINE=(205,226,214); LINE=(160,200,184); GOLD=(236,186,74); GOLD_D=(190,138,40); EDGE=(208,226,216)
def bez(p0,p1,p2,n=40):
    return [((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0],(1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1]) for t in [i/n for i in range(n+1)]]
def book(S,cx,cy,s,mono=False):
    lay=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(lay)
    W=s*1.0; H=s*0.60; x0=cx-W/2; x1=cx+W/2; y0=cy-H/2; y1=cy+H/2; dip=s*0.07
    col=lambda c:(255,255,255,255) if mono else c+(255,)
    # shadow
    if not mono:
        sh=Image.new('L',(S,S),0); sd=ImageDraw.Draw(sh)
        sd.polygon(bez((x0,y1+s*0.02),(cx-W*0.25,y1-s*0.02),(cx,y1+dip+s*0.03))+bez((cx,y1+dip+s*0.03),(cx+W*0.25,y1-s*0.02),(x1,y1+s*0.02))+[(x1,y0+s*0.1),(x0,y0+s*0.1)],fill=110)
        sh=sh.filter(ImageFilter.GaussianBlur(s*0.045)); lay.paste((0,38,26,255),(0,s*0.035),sh) if False else lay.paste((0,38,26,255),(0,0),sh.transform(sh.size,Image.AFFINE,(1,0,0,0,1,-s*0.04)))
    # page-block edges (thickness)
    for k,c in ([] if mono else [(2,EDGE),(1,(236,246,240))]):
        o=k*s*0.022
        d.polygon(bez((x0,y1+o),(cx-W*0.24,y1-s*0.03+o),(cx,y1+dip+o))+bez((cx,y1+dip+o),(cx+W*0.24,y1-s*0.03+o),(x1,y1+o))+[(x1,y1)]+bez((x1,y1),(cx+W*0.24,y1-s*0.03),(cx,y1+dip))+bez((cx,y1+dip),(cx-W*0.24,y1-s*0.03),(x0,y1)),fill=col(c))
    # left page
    top=bez((x0,y0+s*0.02),(cx-W*0.24,y0-s*0.05),(cx,y0+dip)); bot=bez((cx,y1+dip),(cx-W*0.24,y1-s*0.03),(x0,y1))
    d.polygon(top+bot,fill=col(CREAM))
    # right page underneath (the next page)
    rtop=bez((cx,y0+dip),(cx+W*0.24,y0-s*0.05),(x1,y0+s*0.02)); rbot=bez((x1,y1),(cx+W*0.24,y1-s*0.03),(cx,y1+dip))
    d.polygon(rtop+rbot,fill=col(UNDER if not mono else (255,255,255)))
    if not mono:
        # spine shading
        for i in range(14):
            t=i/14; a=int(60*(1-t))
            xa=cx-s*0.12*t; 
        sp=Image.new('L',(S,S),0); spd=ImageDraw.Draw(sp); spd.line([(cx,y0+dip),(cx,y1+dip)],fill=255,width=int(s*0.05)); sp=sp.filter(ImageFilter.GaussianBlur(s*0.03))
        lay.paste(SPINE+(255,),(0,0),sp.point(lambda v:int(v*0.7)))
        # text lines on the left page
        lw=max(2,int(s*0.032))
        for k,L in enumerate([0.95,0.95,0.95,0.95,0.6]):
            yy=y0+H*0.2+k*H*0.15
            xa=x0+W*0.07; xb=xa+W*0.34*L
            d.line([(xa,yy),(xb,yy+s*0.012*L)],fill=LINE+(255,),width=lw)
    # the page being turned: lifts from the right edge and curls toward the spine
    tip=(cx+W*0.30,y0-s*0.12)
    curl=bez((cx,y0+dip),(cx+W*0.10,y0-s*0.02),tip)+bez(tip,(cx+W*0.48,y0+H*0.35),(cx+W*0.40,y1-s*0.02))+bez((cx+W*0.40,y1-s*0.02),(cx+W*0.20,y1+s*0.01),(cx,y1+dip))
    if mono:
        d.polygon(curl,fill=(255,255,255,255))
    else:
        cm=Image.new('L',(S,S),0); ImageDraw.Draw(cm).polygon(curl,fill=255)
        grad=Image.new('RGBA',(S,S)); gd=ImageDraw.Draw(grad)
        for x in range(int(cx),int(cx+W*0.5)+1):
            t=(x-cx)/(W*0.5); c=lerp((236,246,240),CREAM,min(1,t*1.6)) if t<0.62 else lerp(CREAM,(218,236,226),(t-0.62)/0.38)
            gd.line([(x,0),(x,S)],fill=c+(255,))
        lay.paste(grad,(0,0),cm)
    # spine gap for mono
    if mono:
        g=Image.new('L',(S,S),0); ImageDraw.Draw(g).line([(cx,y0+dip+s*0.02),(cx,y1+dip)],fill=255,width=int(s*0.035)); lay.paste((0,0,0,0),(0,0),g)
    # ribbon hanging from the spine
    rw=s*0.085; rx=cx-s*0.02; ry0=y1+dip-s*0.05; ry1=y1+dip+s*0.2
    d.polygon([(rx,ry0),(rx+rw,ry0),(rx+rw,ry1),(rx+rw/2,ry1-rw*0.7),(rx,ry1)],fill=(255,255,255,255) if mono else GOLD+(255,))
    if not mono: d.polygon([(rx,ry0),(rx+rw,ry0),(rx+rw,ry0+s*0.05),(rx,ry0+s*0.07)],fill=GOLD_D+(255,))
    return lay
def legacy(size, round_=False):
    S=size*4; im=bg(S,'round' if round_ else 'square'); im.alpha_composite(book(S,S/2,S/2-S*0.03,S*0.64)); return im.resize((size,size),Image.LANCZOS)
def fg(size,mono=False):
    S=size*4; return book(S,S/2,S/2-S*0.02,S*0.46,mono).resize((size,size),Image.LANCZOS)
def bgl(size):
    S=size*4; return bg(S,'full').resize((size,size),Image.LANCZOS)
res=sys.argv[1] if len(sys.argv)>1 else None
if res:
    for dpi,(ls,fs) in {'mdpi':(48,108),'hdpi':(72,162),'xhdpi':(96,216),'xxhdpi':(144,324),'xxxhdpi':(192,432)}.items():
        legacy(ls).save(f'{res}/mipmap-{dpi}/ic_launcher.png'); legacy(ls,True).save(f'{res}/mipmap-{dpi}/ic_launcher_round.png')
        fg(fs).save(f'{res}/mipmap-{dpi}/ic_launcher_foreground.png'); bgl(fs).save(f'{res}/mipmap-{dpi}/ic_launcher_background.png'); fg(fs,True).save(f'{res}/mipmap-{dpi}/ic_launcher_monochrome.png')
L=legacy(512); R=legacy(512,True)
m=fg(432,True).resize((512,512)); disc=Image.new('RGBA',(512,512),(0,0,0,0)); ImageDraw.Draw(disc).ellipse([0,0,511,511],fill=(214,232,222,255)); disc.paste(Image.new('RGBA',(512,512),(30,58,46,255)),(0,0),m.split()[3])
# adaptive masked as a squircle-ish circle like a launcher would
A=Image.new('RGBA',(432,432)); A.alpha_composite(bgl(432)); A.alpha_composite(fg(432)); mk=Image.new('L',(432,432),0); ImageDraw.Draw(mk).ellipse([0,0,431,431],fill=255); Ad=Image.new('RGBA',(432,432),(0,0,0,0)); Ad.paste(A,(0,0),mk); Ad=Ad.resize((512,512))
sheet=Image.new('RGBA',(2180,560),(243,244,247,255))
for i,im in enumerate([L,R,Ad,disc]): sheet.alpha_composite(im,(24+i*540,24))
sheet.save('/root/t/icon/preview2.png')
small=Image.new('RGBA',(460,150),(22,25,34,255))
for i,sz in enumerate([48,72,96,120]): small.alpha_composite(legacy(sz),(14+i*112-(sz-96)//2 if sz>96 else 14+i*112,15+(120-sz)//2))
small.save('/root/t/icon/small2.png')
