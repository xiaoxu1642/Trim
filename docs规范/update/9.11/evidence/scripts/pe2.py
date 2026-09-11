import struct, sys, os, re

def secs(data):
    e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
    coff = e_lfanew + 4
    machine, nsec = struct.unpack_from('<HH', data, coff)
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    optsz = struct.unpack_from('<H', data, coff+16)[0]
    sec_off = opt + optsz
    out = []
    for i in range(nsec):
        o = sec_off + 40*i
        nm = data[o:o+8].rstrip(b'\0').decode('latin1')
        vsz, vaddr, rsz, raddr = struct.unpack_from('<IIII', data, o+8)
        out.append((nm, vaddr, vsz, raddr, rsz))
    return out, opt, magic

def r2o(rva, S):
    for nm, va, vsz, ra, rs in S:
        if va <= rva < va + max(vsz, rs):
            return ra + (rva - va)
    return None

def imports(data, S):
    e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
    coff = e_lfanew + 4
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    dd_off = opt + (96 if magic == 0x10b else 112)
    rva, sz = struct.unpack_from('<II', data, dd_off + 8*1)
    off = r2o(rva, S)
    if off is None: return {}
    res = {}
    p = off
    while True:
        olt, tds, fc, nmrva, fta = struct.unpack_from('<IIIII', data, p)
        if nmrva == 0: break
        noff = r2o(nmrva, S)
        dll = ''
        if noff:
            e = data.index(b'\0', noff)
            dll = data[noff:e].decode('latin1')
        fns = []
        if fta:
            foff = r2o(fta, S)
            q = foff
            for i in range(2048):
                hint_first = struct.unpack_from('<I', data, q)[0] if q+4 <= len(data) else 0
                v = struct.unpack_from('<I', data, q)[0]
                if v == 0: break
                if v & 0x80000000:
                    fns.append('ord:%d' % (v & 0xffff))
                else:
                    so = r2o(v, S)
                    if so:
                        e2 = data.index(b'\0', so+2)
                        fns.append(data[so+2:e2].decode('latin1'))
                q += 4
                if q - foff > 8192: break
        else:
            q = r2o(olt, S)
            for i in range(4096):
                v = struct.unpack_from('<I', data, q)[0]
                if v == 0: break
                if v & 0x80000000:
                    fns.append('ord:%d' % (v & 0xffff))
                else:
                    so = r2o(v, S)
                    if so:
                        e2 = data.index(b'\0', so+2)
                        fns.append(data[so+2:e2].decode('latin1'))
                q += 4
        res[dll] = fns
        p += 20
        if p - off > 200000: break
    return res

RT = {1:'CURSOR',2:'BITMAP',3:'ICON',4:'MENU',5:'DIALOG',6:'STRING',7:'FONTDIR',8:'FONT',
      9:'ACCELERATOR',10:'RCDATA',11:'MESSAGETABLE',12:'GROUP_CURSOR',14:'GROUP_ICON',
      16:'VERSION',17:'DLGINCLUDE',19:'PLUGPLAY',20:'VXD',21:'ANICURSOR',22:'ANIICON',23:'HTML',24:'MANIFEST'}

def walk_rsrc(data, S, base_rva, node_off, level=0, path=(), out=None, depth=0):
    if out is None: out = []
    if depth > 3: return out
    named, idn = struct.unpack_from('<HH', data, node_off + 12)
    total = named + idn
    for i in range(total):
        e = node_off + 16 + 8*i
        nid, sub = struct.unpack_from('<II', data, e)
        name = None
        if nid & 0x80000000:
            noff = r2o(base_rva + (nid & 0x7fffffff), S)
            if noff:
                ln = struct.unpack_from('<H', data, noff)[0]
                name = data[noff+2:noff+2+ln*2].decode('utf-16-le', 'replace')
        else:
            name = str(nid)
        if sub & 0x80000000:
            walk_rsrc(data, S, base_rva, r2o(base_rva + (sub & 0x7fffffff), S), level+1, path+(name,), out, depth+1)
        else:
            eoff = r2o(base_rva + sub, S)
            rva, sz, cp, res = struct.unpack_from('<IIII', data, eoff)
            out.append((path + (name,), r2o(rva, S), sz))
    return out

def resources(data, S):
    e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
    coff = e_lfanew + 4
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    dd_off = opt + (96 if magic == 0x10b else 112)
    rva, sz = struct.unpack_from('<II', data, dd_off + 8*2)
    if rva == 0: return []
    return walk_rsrc(data, S, rva, r2o(rva, S))

if __name__ == '__main__':
    for path in sys.argv[1:]:
        data = open(path, 'rb').read()
        S, opt, magic = secs(data)
        print('='*70); print(os.path.basename(path))
        print('--- IMPORTS ---')
        imp = imports(data, S)
        for dll in sorted(imp):
            print(f'  {dll}: {len(imp[dll])}')
            if dll.lower().startswith(('kernel32','ntdll','advapi32','shell32','shlwapi','version','psapi','msi','wininet','winhttp','dbghelp','imagehlp','cabinet','esent','srclient','virtdisk','setupapi','powrprof','netapi32','mpr','tlhelp32','userenv','crypt32','wintrust','ole32','gdi32','user32','comctl32','uxtheme','gdiplus','oleaut32','comdlg32','ws2_32','pdh','iphlpapi','propsys','winspool','oleacc','urlmon','shcore','sensapi','normaliz','winmm')):
                print('      ' + ', '.join(sorted(set(imp[dll]))))
        print('--- RESOURCES ---')
        try:
            rs = resources(data, S)
        except Exception as ex:
            print('  rsrc err', ex); rs = []
        agg = {}
        for p, off, sz in rs:
            t = RT.get(int(p[0]) if p[0].isdigit() else -1, p[0]) if len(p) > 0 else '?'
            agg.setdefault(t, [0, 0])
            agg[t][0] += 1
            agg[t][1] += sz
        for t, (c, s) in agg.items():
            print(f'  {t}: count={c} bytes={s}')
        print('  --- named (non-numeric) resource entries (first 120) ---')
        cnt = 0
        for p, off, sz in rs:
            names = [x for x in p[1:] if x and not x.isdigit()]
            if names or (len(p) > 1 and not p[1].isdigit()):
                print(f'   {p} off={off} size={sz}')
                cnt += 1
                if cnt > 120: break
