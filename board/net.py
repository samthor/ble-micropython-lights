import network

import machine
import pyb
pyb.country('AU') # ISO 3166-1 Alpha-2 code, eg US, GB, DE, AU


import time



def do_connect(essid, password):
    sta_if = network.WLAN(network.STA_IF)

    sta_if.active(False)
    time.sleep(1)

    if not sta_if.isconnected():
        start = time.ticks_ms()
        print('connecting to network...')
        sta_if.active(True)
        sta_if.connect(essid, password)
        while not sta_if.isconnected():
            if start + 1000 >= time.ticks_ms():
                print('abandon, took too long')
                return
            pass
    print('network config:', sta_if.ifconfig())


do_connect('HausHouse', 'lolbutts44')
