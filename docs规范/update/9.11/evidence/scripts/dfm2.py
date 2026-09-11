import sys, os, re

IDENT = set(b'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789')

def shortstr(b, p):
    if p >= len(b): return None
    ln = b[p]
    if ln == 0 or p + 1 + ln > len(b): return None
    s = b[p+1:p+1+ln]
    if not all(c in IDENT for c in s): return None
    return s.decode('latin1'), p + 1 + ln

EVENTS = [b'OnClick', b'OnChange', b'OnExecute', b'OnClose', b'OnActivate', b'OnCreate',
          b'OnKeyDown', b'OnTimer', b'OnMouseDown', b'OnMouseUp', b'OnDblClick', b'OnShow']

def parse(path):
    b = open(path, 'rb').read()
    if b[:4] != b'TPF0': return None
    out = []
    p = 4
    n = len(b)
    while p < n - 2:
        r1 = shortstr(b, p)
        if not r1:
            p += 1; continue
        name, q = r1
        r2 = shortstr(b, q)
        if r2:
            cls, q2 = r2
            if cls.startswith('T') and len(cls) > 3 and not name.startswith('T'):
                out.append((p, 'OBJ', name, cls))
                p = q2
                continue
        p += 1
    # events
    evs = []
    for ev in EVENTS:
        i = 0
        while True:
            i = b.find(ev + b'\x07', i)
            if i < 0: break
            r = shortstr(b, i + len(ev) + 1)
            if r:
                evs.append((i, ev.decode(), r[0]))
            i += 1
    return out, evs

for path in sys.argv[1:]:
    res = parse(path)
    if not res:
        print(path, 'not DFM'); continue
    out, evs = res
    print('=' * 60)
    print(os.path.basename(path))
    for off, kind, name, cls in out:
        print('  %-28s : %s' % (name, cls))
    print('  --- events ---')
    for off, ev, h in evs:
        print('  %-12s = %s' % (ev, h))
