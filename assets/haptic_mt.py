#!/usr/bin/env python3
"""Lock-in Orb 觸控板震動（分段強度版）

用 macOS 私有框架 MultitouchSupport 的 MTActuator 直接驅動觸控板的震動馬達
（開源專案 HapticKey 也是這樣做的）。比系統公開的 NSHapticFeedbackManager 多了兩個好處：
  1. 可以選不同的 actuation ID：3 = 弱、4 = 中、6 = 強（HapticKey 的對照）
  2. 手指沒碰著觸控板也會震

只用 Python 內建的 ctypes，不需要編譯、不需要另外安裝套件。

用法
  python3 haptic_mt.py            常駐模式：從 stdin 一行讀一個指令，例如 "6" 或 "6 2.0"
  python3 haptic_mt.py --ladder   測試：依序播放各段強度
啟動成功會印出 "READY mt ..."；不能用時印出 "NOMT 原因" 並以代碼 2 結束（Lock-in Orb 會改用備援方式）。
"""
import ctypes
import faulthandler
import platform
import sys
import time

faulthandler.enable()  # 萬一呼叫系統框架時當掉，至少印出在哪裡
from ctypes import (POINTER, byref, c_bool, c_char_p, c_float, c_int, c_int32,
                    c_int64, c_long, c_uint32, c_uint64, c_ulong, c_void_p)


def out(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def fail(msg):
    out("NOMT " + msg)
    sys.exit(2)


if sys.platform != "darwin":
    fail("not macOS")

try:
    CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    IOK = ctypes.CDLL("/System/Library/Frameworks/IOKit.framework/IOKit")
    MT = ctypes.CDLL("/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport")
except OSError as e:
    fail("cannot load frameworks: %s" % e)

try:
    CF.CFStringCreateWithCString.argtypes = [c_void_p, c_char_p, c_uint32]
    CF.CFStringCreateWithCString.restype = c_void_p
    CF.CFGetTypeID.argtypes = [c_void_p]
    CF.CFGetTypeID.restype = c_ulong
    CF.CFBooleanGetTypeID.argtypes = []
    CF.CFBooleanGetTypeID.restype = c_ulong
    CF.CFNumberGetTypeID.argtypes = []
    CF.CFNumberGetTypeID.restype = c_ulong
    CF.CFBooleanGetValue.argtypes = [c_void_p]
    CF.CFBooleanGetValue.restype = c_bool
    CF.CFNumberGetValue.argtypes = [c_void_p, c_long, c_void_p]
    CF.CFNumberGetValue.restype = c_bool
    CF.CFRelease.argtypes = [c_void_p]
    CF.CFRelease.restype = None

    IOK.IOServiceMatching.argtypes = [c_char_p]
    IOK.IOServiceMatching.restype = c_void_p
    IOK.IOServiceGetMatchingServices.argtypes = [c_uint32, c_void_p, POINTER(c_uint32)]
    IOK.IOServiceGetMatchingServices.restype = c_int
    IOK.IOIteratorNext.argtypes = [c_uint32]
    IOK.IOIteratorNext.restype = c_uint32
    IOK.IORegistryEntryCreateCFProperty.argtypes = [c_uint32, c_void_p, c_void_p, c_uint32]
    IOK.IORegistryEntryCreateCFProperty.restype = c_void_p
    IOK.IOObjectRelease.argtypes = [c_uint32]
    IOK.IOObjectRelease.restype = c_int

    MT.MTActuatorCreateFromDeviceID.argtypes = [c_uint64]
    MT.MTActuatorCreateFromDeviceID.restype = c_void_p
    MT.MTActuatorOpen.argtypes = [c_void_p]
    MT.MTActuatorOpen.restype = c_int
    MT.MTActuatorClose.argtypes = [c_void_p]
    MT.MTActuatorClose.restype = c_int
    MT.MTActuatorActuate.argtypes = [c_void_p, c_int32, c_uint32, c_float, c_float]
    MT.MTActuatorActuate.restype = c_int
except AttributeError as e:
    fail("missing symbol: %s" % e)

UTF8 = 0x08000100      # kCFStringEncodingUTF8
SINT64 = 4             # kCFNumberSInt64Type


def cfstr(s):
    return CF.CFStringCreateWithCString(None, s.encode("utf-8"), UTF8)


def prop(service, key):
    k = cfstr(key)
    try:
        return IOK.IORegistryEntryCreateCFProperty(service, k, None, 0)
    finally:
        CF.CFRelease(k)


def as_bool(ref):
    if not ref:
        return False
    try:
        tid = CF.CFGetTypeID(ref)
        if tid == CF.CFBooleanGetTypeID():
            return bool(CF.CFBooleanGetValue(ref))
        if tid == CF.CFNumberGetTypeID():
            v = c_int64(0)
            CF.CFNumberGetValue(ref, SINT64, byref(v))
            return v.value != 0
        return False
    finally:
        CF.CFRelease(ref)


def as_u64(ref):
    if not ref:
        return None
    try:
        if CF.CFGetTypeID(ref) != CF.CFNumberGetTypeID():
            return None
        v = c_int64(0)
        if not CF.CFNumberGetValue(ref, SINT64, byref(v)):
            return None
        return v.value & 0xFFFFFFFFFFFFFFFF
    finally:
        CF.CFRelease(ref)


def find_device_ids():
    """內建、支援震動的觸控板（同 HapticKey：ActuationSupported 且 MT Built-In）。"""
    it = c_uint32(0)
    # IOServiceGetMatchingServices 會接管 matching dictionary，不用自己釋放
    if IOK.IOServiceGetMatchingServices(0, IOK.IOServiceMatching(b"AppleMultitouchDevice"), byref(it)) != 0:
        return []
    ids = []
    try:
        while True:
            svc = IOK.IOIteratorNext(it.value)
            if not svc:
                break
            try:
                if as_bool(prop(svc, "ActuationSupported")) and as_bool(prop(svc, "MT Built-In")):
                    mid = as_u64(prop(svc, "Multitouch ID"))
                    if mid:
                        ids.append(mid)
            finally:
                IOK.IOObjectRelease(svc)
    finally:
        IOK.IOObjectRelease(it.value)
    return ids


def open_actuator():
    for mid in find_device_ids():
        act = MT.MTActuatorCreateFromDeviceID(mid)
        if not act:
            continue
        if MT.MTActuatorOpen(act) == 0:
            return act, mid
        CF.CFRelease(act)
    return None, None


act, device_id = open_actuator()
if not act:
    fail("no built-in trackpad actuator")


def actuate(aid, u3=2.0):
    """觸發一次震動；失敗時重新打開觸控板再試一次（HapticKey 的做法）。"""
    global act
    if act and MT.MTActuatorActuate(act, aid, 0, 0.0, u3) == 0:
        return True
    try:
        if act:
            MT.MTActuatorClose(act)
            CF.CFRelease(act)
    except Exception:  # noqa: BLE001
        pass
    act, _ = open_actuator()
    return bool(act) and MT.MTActuatorActuate(act, aid, 0, 0.0, u3) == 0


def ladder():
    print("Python %s (%s)，觸控板 0x%x" % (sys.version.split()[0], platform.machine(), device_id), flush=True)
    print("觸控板會依序震動。手掌放在觸控板旁邊的位置最容易感覺到，不用碰觸控板。\n", flush=True)
    for name, aid in (("第 1 段（輕）", 3), ("第 2 段（中）", 4), ("第 3 段（強）", 6)):
        print("%s  ID %d" % (name, aid), flush=True)
        for _ in range(4):
            actuate(aid)
            time.sleep(0.25)
        time.sleep(0.8)
    print("第 4 段（最重：強力連打）  ID 6 ×2", flush=True)
    for _ in range(4):
        actuate(6)
        time.sleep(0.05)
        actuate(6)
        time.sleep(0.35)
    time.sleep(0.8)
    print("\n其他 ID（如果覺得哪個比 6 更重，告訴我）：", flush=True)
    for aid in (1, 2, 5, 15, 16):
        print("  ID %d" % aid, flush=True)
        for _ in range(3):
            actuate(aid)
            time.sleep(0.3)
        time.sleep(0.6)
    print("\n結束。", flush=True)


if "--ladder" in sys.argv:
    ladder()
    sys.exit(0)

out("READY mt 0x%x" % device_id)
stdin = sys.stdin.buffer
while True:
    line = stdin.readline()
    if not line:
        break  # Lock-in Orb 關閉 → stdin 結束 → 跟著結束
    parts = line.split()
    if not parts:
        continue
    try:
        aid = int(parts[0])
        u3 = float(parts[1]) if len(parts) > 1 else 2.0
    except ValueError:
        continue
    if not actuate(aid, u3) and not act:
        out("LOST")
        sys.exit(3)
