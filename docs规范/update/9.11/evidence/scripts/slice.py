import sys
lo, hi = int(sys.argv[2]), int(sys.argv[3])
seen = set()
for line in open(sys.argv[1], 'r', encoding='utf-8', errors='replace'):
    if '\t' not in line: continue
    o, s = line.rstrip('\n').split('\t', 1)
    o = int(o)
    if lo <= o <= hi:
        print('%8d  %s' % (o, s))
