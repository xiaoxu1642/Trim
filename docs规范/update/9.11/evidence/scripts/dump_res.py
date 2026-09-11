import sys, os, re, struct

data = open(sys.argv[1], 'rb').read()
outdir = sys.argv[2]
os.makedirs(outdir, exist_ok=True)

targets = {
 'TEMPTYFOLDERFORM': (14171772, 28266),
 'TEMPTYFOLSETTFORM': (14200040, 2435),
 'TJFCLEANERFORM': (14393444, 42007),
 'TJFSETTINGFORM': (14435452, 7564),
 'TFJIGNOREFORM': (14299832, 1147),
 'TEXCLUSIONLISTFORM': (14202476, 1026),
 'TCUSTOMCLEANFORM': (14033940, 2973),
 'TADDCUSTOMCLEANFORM': (13740220, 1270),
 'TDISKANALYZERFORM': (14037716, 66774),
 'TDUPLICATEFILEFINDERFORM': (14104492, 44608),
 'LOCALDB': (12068640, 366566),
 'ENGLISHLANG': (9841248, 125150),
 'CHINESESIMLANG': (9396556, 90926),
 'PACKAGEINFO': (12448320, 6240),
}

for name, (off, sz) in targets.items():
    blob = data[off:off+sz]
    open(os.path.join(outdir, name + '.bin'), 'wb').write(blob)
    if blob[:4] == b'TPF0':
        # dump ordered shortstrings
        p = 4
        out = []
        while p < len(blob) - 1:
            ln = blob[p]
            if ln == 0:
                p += 1; continue
            if p + 1 + ln <= len(blob):
                s = blob[p+1:p+1+ln]
                if all(32 <= c < 127 for c in s) and ln >= 2:
                    out.append('%d: %s' % (p, s.decode('latin1')))
                p += 1 + ln
            else:
                break
        open(os.path.join(outdir, name + '.dfm.txt'), 'w', encoding='utf-8').write('\n'.join(out))
        print(name, 'DFM strings:', len(out))
    else:
        print(name, 'magic=', blob[:16])
