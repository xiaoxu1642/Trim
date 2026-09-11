import re, sys
from collections import Counter
data = open(sys.argv[1], 'r', encoding='utf-8', errors='replace').read()
bad = ('System','Vcl','Winapi','VirtualTrees','Id','Data','Xml','Soap','Rest','Web','Datasnap',
       'FireDAC','Bde','EMS','IPPeer','AppAnalytics','SHDocVw','MSHTML','Winapi','Win','Vcl')
pat = re.compile(r'\b([A-Za-z_][A-Za-z0-9_]{2,})\.(T[A-Z][A-Za-z0-9_]{2,})\b')
c = Counter()
for m in pat.finditer(data):
    u, k = m.group(1), m.group(2)
    if u.startswith(bad): continue
    c['%s.%s' % (u, k)] += 1
for k, n in sorted(c.items()):
    print('%5d  %s' % (n, k))
