import os, sys, time, ctypes, threading, queue
from ctypes import wintypes

ROOT = sys.argv[1] if len(sys.argv) > 1 else r'C:\Windows'
MAXFILES = int(sys.argv[2]) if len(sys.argv) > 2 else 200000


def bench_scandir(root):
    n = 0; dirs = 0; total = 0
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
                            total += e.stat(follow_symlinks=False).st_size
                            n += 1
                    except OSError:
                        pass
        except OSError:
            pass
    return time.perf_counter() - t0, n, dirs, total


class FILETIME(ctypes.Structure):
    _fields_ = [('dwLowDateTime', wintypes.DWORD), ('dwHighDateTime', wintypes.DWORD)]


class WIN32_FIND_DATAW(ctypes.Structure):
    _fields_ = [
        ('dwFileAttributes', wintypes.DWORD),
        ('ftCreationTime', FILETIME),
        ('ftLastAccessTime', FILETIME),
        ('ftLastWriteTime', FILETIME),
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
k32.FindClose.restype = wintypes.BOOL
k32.CreateFileW.argtypes = [ctypes.c_wchar_p, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k32.CreateFileW.restype = wintypes.HANDLE
k32.DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                                ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                ctypes.c_void_p]
k32.DeviceIoControl.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]

INVALID = ctypes.c_void_p(-1).value
DIR = 0x10
REPARSE = 0x400


def scan_findfirst(root, workers=1):
    n = [0]; dirs = [0]; total = [0]
    lock = threading.Lock()
    q = queue.Queue()
    q.put(root)

    def worker():
        fd = WIN32_FIND_DATAW()
        while True:
            try:
                d = q.get_nowait()
            except queue.Empty:
                return
            h = k32.FindFirstFileW(os.path.join(d, '*'), ctypes.byref(fd))
            if h == INVALID or h is None:
                continue
            while True:
                name = fd.cFileName
                if name not in ('.', '..'):
                    a = fd.dwFileAttributes
                    if a & DIR:
                        if not (a & REPARSE):
                            with lock:
                                dirs[0] += 1
                            q.put(os.path.join(d, name))
                    else:
                        with lock:
                            n[0] += 1
                            total[0] += (fd.nFileSizeHigh << 32) | fd.nFileSizeLow
                if not k32.FindNextFileW(h, ctypes.byref(fd)):
                    break
            k32.FindClose(h)

    t0 = time.perf_counter()
    if workers == 1:
        q2 = queue.Queue(); q2.put(root)
        # single thread inline (avoid thread overhead)
        fd = WIN32_FIND_DATAW()
        stack = [root]
        while stack and n[0] < MAXFILES:
            d = stack.pop()
            h = k32.FindFirstFileW(os.path.join(d, '*'), ctypes.byref(fd))
            if h == INVALID or h is None:
                continue
            while True:
                name = fd.cFileName
                if name not in ('.', '..'):
                    a = fd.dwFileAttributes
                    if a & DIR:
                        if not (a & REPARSE):
                            dirs[0] += 1
                            stack.append(os.path.join(d, name))
                    else:
                        n[0] += 1
                        total[0] += (fd.nFileSizeHigh << 32) | fd.nFileSizeLow
                if not k32.FindNextFileW(h, ctypes.byref(fd)):
                    break
            k32.FindClose(h)
    else:
        ths = [threading.Thread(target=worker, daemon=True) for _ in range(workers)]
        for t in ths: t.start()
        for t in ths: t.join()
    return time.perf_counter() - t0, n[0], dirs[0], total[0]


FSCTL_QUERY_USN_JOURNAL = 0x000900f4
FSCTL_ENUM_USN_DATA = 0x000900b3


class USN_JOURNAL_DATA(ctypes.Structure):
    _fields_ = [('UsnJournalID', ctypes.c_ulonglong), ('FirstUsn', ctypes.c_longlong),
                ('NextUsn', ctypes.c_longlong), ('LowestValidUsn', ctypes.c_longlong),
                ('MaxUsn', ctypes.c_longlong), ('MaximumSize', ctypes.c_ulonglong),
                ('AllocationDelta', ctypes.c_ulonglong)]


class MFT_ENUM_DATA(ctypes.Structure):
    _fields_ = [('StartFileReferenceNumber', ctypes.c_ulonglong),
                ('LowUsn', ctypes.c_longlong), ('HighUsn', ctypes.c_longlong)]


def bench_usn(drive):
    vol = r'\\.\%s' % drive
    h = k32.CreateFileW(vol, 0x80000000, 0x00000001 | 0x00000002, None, 3, 0x80000000, None)
    if h == INVALID or h is None:
        return 'CreateFileW 失败 err=%d（多半是没管理员权限）' % ctypes.get_last_error()
    jd = USN_JOURNAL_DATA()
    br = wintypes.DWORD()
    ok = k32.DeviceIoControl(h, FSCTL_QUERY_USN_JOURNAL, None, 0, ctypes.byref(jd),
                             ctypes.sizeof(jd), ctypes.byref(br), None)
    if not ok:
        err = ctypes.get_last_error()
        k32.CloseHandle(h)
        return 'FSCTL_QUERY_USN_JOURNAL 失败 err=%d' % err
    med = MFT_ENUM_DATA(0, 0, jd.NextUsn)
    buf = ctypes.create_string_buffer(1 << 20)
    count = 0
    t0 = time.perf_counter()
    while True:
        ok = k32.DeviceIoControl(h, FSCTL_ENUM_USN_DATA, ctypes.byref(med), ctypes.sizeof(med),
                                 buf, 1 << 20, ctypes.byref(br), None)
        if not ok:
            break
        data = buf.raw[:br.value]
        if br.value <= 8:
            break
        nxt = int.from_bytes(data[:8], 'little')
        if nxt == 0:
            break
        p = 8
        while p + 60 <= len(data):
            reclen = int.from_bytes(data[p:p+4], 'little')
            if reclen <= 0: break
            count += 1
            p += reclen
        med.StartFileReferenceNumber = nxt
    dt = time.perf_counter() - t0
    k32.CloseHandle(h)
    return 'USN 枚举成功：%d 条记录，%.2fs（%.0f 条/s）' % (count, dt, count/dt if dt else 0)


if __name__ == '__main__':
    print('目标目录 =', ROOT, ' 上限文件数 =', MAXFILES)
    t, n, d, sz = bench_scandir(ROOT)
    print('A. os.scandir + stat : %7.3fs  files=%d dirs=%d  %.1f GB  (%.0f files/s)'
          % (t, n, d, sz / 2**30, n / t if t else 0))
    t2, n2, d2, sz2 = scan_findfirst(ROOT, 1)
    print('B. FindFirstFileW(1线程): %7.3fs  files=%d dirs=%d  %.1f GB  (%.0f files/s)'
          % (t2, n2, d2, sz2 / 2**30, n2 / t2 if t2 else 0))
    t3, n3, d3, sz3 = scan_findfirst(ROOT, 4)
    print('C. FindFirstFileW(4线程): %7.3fs  files=%d dirs=%d  %.1f GB  (%.0f files/s)'
          % (t3, n3, d3, sz3 / 2**30, n3 / t3 if t3 else 0))
    print('   A/B = %.2fx   B/C = %.2fx' % (t / t2 if t2 else 0, t2 / t3 if t3 else 0))
    print('D.', bench_usn('C:'))
