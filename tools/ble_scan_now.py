#!/usr/bin/env python3
"""Escaneo BLE rápido: ¿está el Stackchan (Claude-*) anunciando AHORA?
Corre con el python de IDF: ~/.espressif/python_env/idf6.0_py3.14_env/bin/python"""
import time, sys
import objc
from CoreBluetooth import CBCentralManager
from Foundation import NSObject, NSRunLoop, NSDate

NUS = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E'

class Delegate(NSObject):
    def init(self):
        self = objc.super(Delegate, self).init()
        self.seen = []
        return self
    def centralManagerDidUpdateState_(self, c):
        print(f'BT central state={c.state()} (5=poweredOn)', flush=True)
        if c.state() == 5:
            # scan sin filtro de servicio: vemos TODO lo que anuncia cerca
            c.scanForPeripheralsWithServices_options_(None, None)
    def centralManager_didDiscoverPeripheral_advertisementData_RSSI_(self, c, p, ad, rssi):
        name = ad.get('kCBAdvDataLocalName') or p.name() or ''
        svc = ad.get('kCBAdvDataServiceUUIDs') or []
        svc = [str(s) for s in svc]
        has_nus = any(NUS.lower() in s.lower() for s in svc)
        entry = (str(name), has_nus, int(rssi))
        if entry not in self.seen:
            self.seen.append(entry)
            tag = '  <== NUS' if has_nus else ''
            print(f'ADV name={name!r:30} rssi={rssi:>5} nus={has_nus}{tag}', flush=True)

d = Delegate.new()
mgr = CBCentralManager.alloc().initWithDelegate_queue_(d, None)
deadline = time.time() + float(sys.argv[1]) if len(sys.argv) > 1 else time.time() + 15
while time.time() < deadline:
    NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.5))

print('\n=== RESUMEN ===')
claude = [s for s in d.seen if 'claude' in s[0].lower()]
if claude:
    for name, nus, rssi in claude:
        print(f'  Claude-ish: {name!r} nus={nus} rssi={rssi}')
else:
    print('  NINGÚN dispositivo "Claude*" anunciando.')
print(f'  Total dispositivos vistos: {len(d.seen)}')
