from PIL import Image, ImageDraw, ImageFilter
import math
G1=(20,120,88); G2=(6,66,50)          # emerald gradient
PAGE=(255,255,255); FOLD=(196,230,214); LINE=(172,209,193); GOLD=(233,183,74); GOLD_D=(196,146,46)
def lerp(a,b,t): return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))
def bg(S, shape='square'):
    im=Image.new('RGBA',(S,S),(0,0,0,0)); px=Image.new('RGBA',(S,S))
    d=ImageDraw.Draw(px)
    for y in range(S):  # diagonal gradient approximated per row with slight x shift
        d.line([(0,y),(S,y)],fill=lerp(G1,G2,y/S)+(255,))
    # soft light from top-left
    glow=Image.new('L',(S,S),0); ImageDraw.Draw(glow).ellipse([-S*0.3,-S*0.45,S*0.9,S*0.55],fill=70); glow=glow.filter(ImageFilter.GaussianBlur(S*0.12))
    px=Image.composite(Image.new('RGBA',(S,S),(255,255,255,255)),px,glow.point(lambda v:v*0.35))
    mask=Image.new('L',(S,S),0); md=ImageDraw.Draw(mask)
    if shape=='round': md.ellipse([0,0,S-1,S-1],fill=255)
    elif shape=='square': md.rounded_rectangle([0,0,S-1,S-1],radius=S*0.23,fill=255)
    else: md.rectangle([0,0,S,S],fill=255)
    im.paste(px,(0,0),mask); return im
def glyph(S, cx, cy, s, mono=False):
    """page with a dog-eared corner and a ribbon bookmark; s = page height"""
    lay=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(lay)
    w=s*0.76; h=s; x0=cx-w/2; y0=cy-h/2; x1=x0+w; y1=y0+h; r=s*0.07; f=s*0.26
    white=(255,255,255,255)
    # shadow
    if not mono:
        sh=Image.new('L',(S,S),0); ImageDraw.Draw(sh).rounded_rectangle([x0+s*0.03,y0+s*0.06,x1+s*0.03,y1+s*0.06],radius=r,fill=90)
        sh=sh.filter(ImageFilter.GaussianBlur(s*0.05)); lay.paste((0,40,28,255),(0,0),sh)
    # page body with the top-right corner cut
    body=Image.new('L',(S,S),0); bd=ImageDraw.Draw(body)
    bd.rounded_rectangle([x0,y0,x1,y1],radius=r,fill=255)
    bd.polygon([(x1-f,y0-2),(x1+2,y0-2),(x1+2,y0+f)],fill=0)
    lay.paste(white if mono else PAGE+(255,),(0,0),body)
    if mono:
        # cut the fold line and ribbon notch as gaps so the silhouette still reads
        gap=Image.new('L',(S,S),0); gd=ImageDraw.Draw(gap)
        gd.line([(x1-f,y0),(x1-f,y0+f),(x1,y0+f)],fill=255,width=int(s*0.05))
        lay.paste((0,0,0,0),(0,0),gap)
        gd=ImageDraw.Draw(lay)
        gd.polygon([(x1-f+s*0.05,y0+s*0.0),(x1,y0+f-s*0.05),(x1-f+s*0.05,y0+f-s*0.05)],fill=white)
    else:
        # the folded corner
        d.polygon([(x1-f,y0),(x1,y0+f),(x1-f+r*0.4,y0+f-r*0.1)],fill=FOLD+(255,))
        d.polygon([(x1-f,y0),(x1-f,y0+f*0.9),(x1-f+r*0.4,y0+f-r*0.1),(x1,y0+f),(x1-f*0.1,y0+f)],fill=FOLD+(255,))
        # text lines
        lw=max(2,int(s*0.045))
        for k,L in enumerate([0.62,0.78,0.78,0.78,0.5]):
            yy=y0+h*0.44+k*h*0.105
            d.rounded_rectangle([x0+w*0.14,yy,x0+w*0.14+(w*0.72)*L,yy+lw],radius=lw/2,fill=LINE+(255,))
        # ribbon
        rx=x0+w*0.2; rw=w*0.17; ry0=y0-s*0.04; ry1=y0+h*0.34
        d.polygon([(rx,ry0),(rx+rw,ry0),(rx+rw,ry1),(rx+rw/2,ry1-rw*0.55),(rx,ry1)],fill=GOLD+(255,))
        d.polygon([(rx,ry0),(rx+rw,ry0),(rx+rw,ry0+s*0.04)],fill=GOLD_D+(255,))
    if mono:
        # ribbon as a notch cut into the page
        cut=Image.new('L',(S,S),0); cd=ImageDraw.Draw(cut)
        rx=x0+w*0.2; rw=w*0.17; ry1=y0+h*0.34
        cd.polygon([(rx,y0-2),(rx+rw,y0-2),(rx+rw,ry1),(rx+rw/2,ry1-rw*0.55),(rx,ry1)],fill=255)
        lay.paste((0,0,0,0),(0,0),cut)
    return lay
def legacy(size, round_=False):
    S=size*4; im=bg(S,'round' if round_ else 'square')
    im.alpha_composite(glyph(S,S/2,S/2+S*0.02,S*0.56))
    return im.resize((size,size),Image.LANCZOS)
def adaptive_fg(size, mono=False):
    S=size*4; return glyph(S,S/2,S/2+S*0.012,S*0.40,mono).resize((size,size),Image.LANCZOS)
def adaptive_bg(size):
    S=size*4; return bg(S,'full').resize((size,size),Image.LANCZOS)
if __name__=='__main__':
    import sys
    res=sys.argv[1]
    for dpi,(ls,fs) in {'mdpi':(48,108),'hdpi':(72,162),'xhdpi':(96,216),'xxhdpi':(144,324),'xxxhdpi':(192,432)}.items():
        legacy(ls).save(f'{res}/mipmap-{dpi}/ic_launcher.png'); legacy(ls,True).save(f'{res}/mipmap-{dpi}/ic_launcher_round.png')
        adaptive_fg(fs).save(f'{res}/mipmap-{dpi}/ic_launcher_foreground.png')
        adaptive_bg(fs).save(f'{res}/mipmap-{dpi}/ic_launcher_background.png')
        adaptive_fg(fs,True).save(f'{res}/mipmap-{dpi}/ic_launcher_monochrome.png')
    # previews
    L=legacy(512); R=legacy(512,True)
    # themed (Android 13 monochrome) preview: tinted glyph on pale disc
    m=adaptive_fg(432,True).resize((512,512)); tint=Image.new('RGBA',(512,512),(40,60,52,255)); disc=Image.new('RGBA',(512,512),(0,0,0,0)); ImageDraw.Draw(disc).ellipse([0,0,511,511],fill=(214,232,222,255))
    disc.paste(tint,(0,0),m.split()[3]); 
    sheet=Image.new('RGBA',(1650,560),(243,244,247,255))
    for i,im in enumerate([L,R,disc]): sheet.alpha_composite(im,(24+i*540,24))
    sheet.save('/root/t/icon/preview.png')
    small=Image.new('RGBA',(420,150),(22,25,34,255))
    for i,sz in enumerate([48,72,96]): small.alpha_composite(legacy(sz),(20+i*120,20+(96-sz)//2))
    small.save('/root/t/icon/small.png')
