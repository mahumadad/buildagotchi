#!/usr/bin/env python3
"""Conecta a Claude-SC3, descubre TODOS los servicios, lee GAP Device Name (0x2A00).
Objetivo: que macOS refresque su caché de peripheral.name."""
import time
import objc
from CoreBluetooth import CBCentralManager, CBUUID
from Foundation import NSObject, NSRunLoop, NSDate

class Delegate(NSObject):
    def init(self):
        self = objc.super(Delegate, self).init()
        self.periph = None
        self.done = False
        return self
    def centralManagerDidUpdateState_(self, c):
        if c.state() == 5:
            c.scanForPeripheralsWithServices_options_(None, None)
    def centralManager_didDiscoverPeripheral_advertisementData_RSSI_(self, c, p, ad, rssi):
        adv = ad.get('kCBAdvDataLocalName') or ''
        if 'Claude-SC3' in str(adv) and not self.periph:
            self.periph = p
            print(f'scan: adv_name={adv!r} peripheral.name={p.name()!r}', flush=True)
            c.stopScan()
            c.connectPeripheral_options_(p, None)
    def centralManager_didConnectPeripheral_(self, c, p):
        print(f'conectado, peripheral.name={p.name()!r} — descubriendo servicios…', flush=True)
        p.setDelegate_(self)
        p.discoverServices_(None)
    def centralManager_didFailToConnectPeripheral_error_(self, c, p, err):
        print(f'CONNECT FAIL {err}', flush=True); self.done = True
    def centralManager_didDisconnectPeripheral_error_(self, c, p, err):
        print(f'DESCONECTADO err={err}', flush=True); self.done = True
    def peripheral_didDiscoverServices_(self, p, err):
        if err:
            print(f'svc discovery error {err}', flush=True); self.done = True; return
        svcs = p.services() or []
        print(f'servicios: {[str(s.UUID()) for s in svcs]}', flush=True)
        for svc in svcs:
            p.discoverCharacteristics_(None, svc)
    def peripheral_didDiscoverCharacteristicsForService_error_(self, p, svc, err):
        for ch in svc.characteristics() or []:
            if str(ch.UUID()).upper() == '2A00':
                print('leyendo 0x2A00…', flush=True)
                p.readValueForCharacteristic_(ch)
    def peripheral_didUpdateValueForCharacteristic_error_(self, p, ch, err):
        if str(ch.UUID()).upper() != '2A00':
            return
        if err:
            print(f'read 0x2A00 error: {err}', flush=True)
        else:
            v = bytes(ch.value().bytes()) if ch.value() else b''
            print(f'GAP Device Name (0x2A00) = {v.decode("utf-8", "replace")!r}', flush=True)
            print(f'peripheral.name post-read = {p.name()!r}', flush=True)
        self.done = True

d = Delegate.new()
mgr = CBCentralManager.alloc().initWithDelegate_queue_(d, None)
deadline = time.time() + 40
while time.time() < deadline and not d.done:
    NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.5))
if d.periph:
    mgr.cancelPeripheralConnection_(d.periph)
    NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(1))
print('fin', flush=True)
