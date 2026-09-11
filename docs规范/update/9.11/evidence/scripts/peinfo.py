import struct, sys, os, re

def pe_info(path):
    with open(path, 'rb') as f:
        data = f.read()
    d = {}
    if data[:2] != b'MZ':
        return {'error': 'not MZ'}
    e_lfanew = struct.unpack_from('<I', data, 0x3c)[0]
    sig = data[e_lfanew:e_lfanew+4]
    d['e_lfanew'] = e_lfanew
    d['sig'] = sig
    if sig != b'PE\0\0':
        return d
    coff = e_lfanew + 4
    machine, nsec, _, _, _, optsz, chars = struct.unpack_from('<HHIIIHH', data, coff)
    d['machine'] = hex(machine)
    d['num_sections'] = nsec
    d['optional_size'] = optsz
    d['characteristics'] = hex(chars)
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    d['opt_magic'] = hex(magic)
    if magic == 0x10b:
        # PE32
        _, _, _, _, _, numrva = struct.unpack_from('<IIiIII', data, opt+28)
        d['num_rva_and_sizes'] = numrva
        dd_off = opt + 96
    else:
        _, _, _, _, _, numrva = struct.unpack_from('<IIiIII', data, opt+24)
        d['num_rva_and_sizes'] = numrva
        dd_off = opt + 112
    d['num_rva_and_sizes'] = numrva
    names = ['export','import','resource','exception','certificate','reloc','debug','arch','globalptr','tls','loadcfg','boundimport','iat','delayimport','clrheader','reserved']
    d['dirs'] = {}
    for i in range(min(numrva, 16)):
        rva, sz = struct.unpack_from('<II', data, dd_off + 8*i)
        if rva or sz:
            d['dirs'][names[i]] = (hex(rva), sz)
    # sections
    sec_off = opt + optsz
    secs = []
    for i in range(nsec):
        o = sec_off + 40*i
        nm = data[o:o+8].rstrip(b'\0').decode('latin1')
        vsz, vaddr, rsz, raddr = struct.unpack_from('<IIII', data, o+8)
        sch = struct.unpack_from('<I', data, o+36)[0]
        secs.append((nm, hex(vaddr), hex(vsz), raddr, rsz, hex(sch)))
    d['sections'] = secs
    # CLR header
    if 'clrheader' in d['dirs']:
        d['is_dotnet'] = True
    else:
        d['is_dotnet'] = False
    # .NET single-file bundle marker
    idx = data.rfind(b'\x8b\x12\x02\xb9\x6a\x61\x20\xe0\x8f\xc6\x8c\xd2\x96\x1c\xd2\x5e')
    d['bundle_marker_offset'] = idx
    # version resource quick scan
    d['size'] = len(data)
    return d

for p in sys.argv[1:]:
    print('='*70)
    print(p)
    r = pe_info(p)
    for k, v in r.items():
        print(f'  {k}: {v}')
