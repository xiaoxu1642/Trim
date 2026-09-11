import struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pe2 import secs, imports

for path in sys.argv[1:]:
    data = open(path, 'rb').read()
    S, opt, magic = secs(data)
    imp = imports(data, S)
    print('=' * 60)
    print(os.path.basename(path))
    for dll in ('KERNEL32.DLL', 'kernel32.dll', 'ADVAPI32.DLL', 'advapi32.dll'):
        if dll in imp:
            print('--- %s (%d) ---' % (dll, len(imp[dll])))
            fns = sorted(set(imp[dll]))
            for i in range(0, len(fns), 6):
                print('   ' + ', '.join(fns[i:i+6]))
