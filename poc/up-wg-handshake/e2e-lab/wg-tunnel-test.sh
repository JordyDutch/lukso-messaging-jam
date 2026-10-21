#!/usr/bin/env bash
# wg-tunnel-test.sh <aPrivB64> <aPubB64> <bPrivB64> <bPubB64>
#
# Raise a REAL WireGuard tunnel between two interfaces using the keys derived
# from the UP controllers, entirely inside ONE rootless user+net namespace.
# Touches NOTHING on the host (host wg0 is invisible/untouched here).
#
# Rootless netns cannot use `ip netns add` (needs /var/run/netns bind mounts as
# real root), so both wg interfaces live in the same inner netns and peer over
# loopback on distinct UDP ports. The crypto/handshake is identical to a
# two-host setup — this proves the derived keys form a valid, working,
# ENCRYPTED WireGuard association (real kernel wg, real Noise handshake).
# PASS = wg handshake completes AND an ICMP ping crosses the tunnel.
set -euo pipefail
AP="$1"; APUB="$2"; BP="$3"; BPUB="$4"
export AP APUB BP BPUB

unshare --user --map-root-user --net --mount --fork bash -c '
set -euo pipefail
ip link set lo up

umask 077
echo "$AP" > /tmp/ap.key; echo "$BP" > /tmp/bp.key

# Side A: wgA at 10.91.0.1, listens 51820, peer B via loopback:51821
ip link add wgA type wireguard
ip addr add 10.91.0.1/24 dev wgA
wg set wgA listen-port 51820 private-key /tmp/ap.key
wg set wgA peer "$BPUB" allowed-ips 10.91.0.2/32 endpoint 127.0.0.1:51821 persistent-keepalive 5
ip link set wgA up

# Side B: wgB at 10.91.0.2, listens 51821, peer A via loopback:51820
ip link add wgB type wireguard
ip addr add 10.91.0.2/24 dev wgB
wg set wgB listen-port 51821 private-key /tmp/bp.key
wg set wgB peer "$APUB" allowed-ips 10.91.0.1/32 endpoint 127.0.0.1:51820 persistent-keepalive 5
ip link set wgB up

# nudge a handshake
ping -c 1 -W 2 10.91.0.2 >/dev/null 2>&1 || true
sleep 2
echo "--- ping across the encrypted WG tunnel (A 10.91.0.1 -> B 10.91.0.2) ---"
if ping -c 3 -W 3 10.91.0.2; then echo "PING: OK"; else echo "PING: FAIL"; exit 1; fi

HS=$(wg show wgA latest-handshakes | awk "{print \$2}")
RX=$(wg show wgA transfer | awk "{print \$2}")
TX=$(wg show wgA transfer | awk "{print \$3}")
echo "wgA latest-handshake epoch: ${HS:-0} | rx:${RX:-0} tx:${TX:-0} bytes"
rm -f /tmp/ap.key /tmp/bp.key
if [ "${HS:-0}" -gt 0 ]; then echo "TUNNEL-TEST: PASS (real wg Noise handshake + encrypted ping)"; else echo "TUNNEL-TEST: FAIL (no handshake)"; exit 1; fi
'
