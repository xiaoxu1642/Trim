import os, sys, time, ctypes
from ctypes import wintypes

ROOT = sys.argv[1] if len(sys.argv) > 1 else r'C:\Program Files'
MAXFILES = int(sys.argv[2]) if len(sys.argv) > 2 else 400000

def bench_scandir_stat(root):
    n = 0; total = 0; dirs = 0
    t0 = time.perf_counter()
    stack = [root]
    while stack and n < MAXFILES:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            dirs += 1
                            stack.append(e.path)
                        else:
                            st = e.stat(follow_symlinks=False)
                            total += st.st_size
                            n += 1
                    except OSError:
                        pass
        except OSError:
            pass
    return time.perf_counter() - t0, n, dirs, total

class WIN32_FIND_DATAW(ctypes.Structure):
    _fields_ = [
        ('dwFileAttributes', wintypes.DWORD),
        ('ftCreationTime', ctypes.c_ulonglong),
        ('ftLastAccessTime', ctypes.c_ulonglong),
        ('ftLastWriteTime', ctypes.c_ulonglong),
        ('nFileSizeHigh', wintypes.DWORD),
        ('nFileSizeLow', wintypes.DWORD),
        ('dwReserved0', wintypes.DWORD),
        ('dwReserved1', wintypes.DWORD),
        ('cFileName', wintypes.WCHAR * 260),
        ('cAlternateFileName', wintypes.WCHAR * 14),
    ]

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.FindFirstFileW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(WIN32_FIND_DATAW)]
k32.FindFirstFileW.restype = wintypes.HANDLE
k32.FindNextFileW.argtypes = [wintypes.HANDLE, ctypes.POINTER(WIN32_FIND_DATAW)]
k32.FindNextFileW.restype = wintypes.BOOL
k32.FindClose.argtypes = [wintypes.HANDLE]
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_REPARSE_POINT = 0x400

def bench_findfirst(root):
    n = 0; total = 0; dirs = 0
    t0 = time.perf_counter()
    stack = [root]
    fd = WIN32_FIND_DATAW()
    while stack and n < MAXFILES:
        d = stack.pop()
        pat = os.path.join(d, '*')
        h = k32.FindFirstFileW(pat, ctypes.byref(fd))
        if h == INVALID_HANDLE_VALUE:
            continue
        while True:
            name = fd.cFileName
            if name not in ('.', '..'):
                attr = fd.dwFileAttributes
                if attr & FILE_ATTRIBUTE_DIRECTORY and not (attr & FILE_ATTRIBUTE_REPARSE_POINT):
                    dirs += 1
                    stack.append(os.path.join(d, name))
                elif not (attr & FILE_ATTRIBUTE_DIRECTORY):
                    total += (fd.nFileSizeHigh << 32) | fd.nFileSizeLow
                    n += 1
            if not k32.FindNextFileW(h, ctypes.byref(fd)):
                break
        k32.FindClose(h)
    return time.perf_counter() - t0, n, dirs, total

def try_usn(drive):
    # FSCTL_ENUM_USN_DATA = 0x900b3
    FSCTL_ENUM_USN_DATA = 0x000900b3
    vol = r'\\.\%s' % drive
    h = k32.CreateFileW(vol, 0x80000000, 3, None, 3, 0x80000000, None)
    if h == INVALID_HANDLE_VALUE:
        return None, 'CreateFile failed (err=%d)' % ctypes.get_last_error()
    class MFT_ENUM_DATA(ctypes.Structure):
        _fields_ = [('StartFileReferenceNumber', ctypes.c_ulonglong),
                    ('LowUsn', ctypes.c_longlong), ('HighUsn', ctypes.c_longlong)]
    med = MFT_ENUM_DATA(0, 0, 2**62 - 1)
    buf = ctypes.create_string_buffer(0x10000)
    br = wintypes.DWORD()
    ok = k32.DeviceIoControl(h, FSCTL_ENUM_USN_DATA, ctypes.byref(med), ctypes.sizeof(med),
                             buf, 0x10000, ctypes.byref(br), None)
    err = ctypes.get_last_error()
    k32.CloseHandle(h)
    return (bool(ok), 'ok' if ok else 'DeviceIoControl err=%d' % err, br.value)

if __name__ == '__main__':
    print('ROOT =', ROOT)
    t, n, d, sz = bench_scandir_stat(ROOT)
    print('os.scandir + stat : %.3fs  files=%d dirs=%d bytes=%d  (%.0f files/s)' % (t, n, d, sz, n/t if t else 0))
    t2, n2, d2, sz2 = bench_findfirst(ROOT)
    print('FindFirstFileW    : %.3fs  files=%d dirs=%d bytes=%d  (%.0f files/s)' % (t2, n2, d2, sz2, n2/t2 if t2 else 0))
    print('ratio scandir/findfirst = %.2fx' % (t / t2 if t2 else 0))
    r = try_usn('C:')
    print('USN(MFT) probe    :', r)
