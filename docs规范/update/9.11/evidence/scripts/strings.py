import re, sys, os

ASCII = re.compile(rb'[\x20-\x7e]{4,}')
UTF16 = re.compile(rb'(?:[\x20-\x7e]\x00){4,}')

def extract(path, out_ascii, out_u16):
    data = open(path, 'rb').read()
    with open(out_ascii, 'w', encoding='utf-8', errors='replace') as fa, \
         open(out_u16, 'w', encoding='utf-8', errors='replace') as fu:
        for m in ASCII.finditer(data):
            fa.write('%d\t%s\n' % (m.start(), m.group().decode('latin1')))
        for m in UTF16.finditer(data):
            fu.write('%d\t%s\n' % (m.start(), m.group().decode('utf-16-le')))
    print(path, 'ok', len(data))

for i in range(1, len(sys.argv), 3):
    extract(sys.argv[i], sys.argv[i+1], sys.argv[i+2])
