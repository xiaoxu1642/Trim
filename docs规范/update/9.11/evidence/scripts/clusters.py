import re, sys, os
from collections import defaultdict

def load(path):
    out = []
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            if '\t' not in line: continue
            o, s = line.rstrip('\n').split('\t', 1)
            out.append((int(o), s))
    return out

def groups(items, keywords, window=160, minlen=3):
    rx = re.compile(keywords, re.I)
    hits = [(o, s) for o, s in items if rx.search(s)]
    # cluster by offset proximity
    clusters = []
    cur = []
    for o, s in hits:
        if cur and o - cur[-1][0] > window:
            clusters.append(cur); cur = []
        cur.append((o, s))
    if cur: clusters.append(cur)
    return clusters

def main(inp, outp, kw, window=160):
    items = load(inp)
    cl = groups(items, kw, window)
    with open(outp, 'w', encoding='utf-8') as f:
        f.write('### %s  (clusters=%d)\n' % (inp, len(cl)))
        for c in cl:
            f.write('\n--- cluster @%d..%d ---\n' % (c[0][0], c[-1][0]))
            for o, s in c[:400]:
                f.write('%8d  %s\n' % (o, s))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 160)
