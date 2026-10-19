#!/usr/bin/env python3
"""Сквозная проверка Linux-службы в изолированных сетевых пространствах имён.

Запуск (без прав root, хост-сеть не затрагивается):
    unshare -r -n -m python3 scripts/e2e_linux.py helper/bin/linux/awg-helper

Поднимается «сервер» AmneziaWG 3.1 (amneziawg-go) в отдельном netns, клиент подключается через настоящую
службу (`awg-helper serve`), и проверяется: рукопожатие, трафик через туннель, kill switch, отказ в безопасную
сторону при аварии туннеля, чистое отключение, отклонение опасных конфигураций.
"""
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HELPER = os.path.abspath(sys.argv[1])
SOCK = "/run/privata-vpn/helper.sock"
results = []


def sh(cmd, check=True, **kw):
    r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd!r} → {r.returncode}\n{r.stdout}{r.stderr}")
    return r


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  [{detail}]" if detail and not ok else ""), flush=True)


def call(obj, timeout=20):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(timeout)
    s.connect(SOCK)
    s.sendall((json.dumps(obj) + "\n").encode())
    data = b""
    while not data.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    s.close()
    return json.loads(data)


def wait_status(pred, timeout=40):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = call({"op": "status"})["status"]
        if pred(last):
            return last
        time.sleep(0.4)
    return last


def awg_keys():
    priv = sh("awg genkey").stdout.strip()
    pub = subprocess.run(["awg", "pubkey"], input=priv, capture_output=True, text=True).stdout.strip()
    return priv, pub


AWG_PARAMS = None


def params(hpk):
    # параметры в стиле AWG 3.x (значения вымышленные, но того же вида, что в реальных конфигурациях)
    return f"""Jc = 4
Jmin = 10
Jmax = 50
S1 = 73
S2 = 55
S3 = 81
S4 = 21
H1 = 1263359724-1263359837
H2 = 968797362-968797585
H3 = 540538806-540538923
H4 = 631494200-631494423
HeaderProtectionKey = {hpk}
ContentPaddingAddition = 15-24
RekeyAfterTime = 139
RekeyTimeout = 5-6
RejectAfterTime = 163-175
KeepaliveTimeout = 14
MaxHandshakeAttempts = 19-20
"""


def main():
    work = tempfile.mkdtemp(prefix="awg-e2e-")
    sh("mount -t tmpfs tmpfs /run")
    sh("mkdir -p /run/netns")
    sh("ip link set lo up")
    sh("ip netns add srv")
    sh("ip link add veth0 type veth peer name veth1")
    sh("ip link set veth1 netns srv")
    sh("ip addr add 192.0.2.1/24 dev veth0 && ip link set veth0 up")
    sh("ip netns exec srv sh -c 'ip link set lo up; ip addr add 192.0.2.2/24 dev veth1; ip link set veth1 up; ip addr add 198.51.100.1/32 dev lo'")
    sh("ip route add default via 192.0.2.2 dev veth0")

    spriv, spub = awg_keys()
    cpriv, cpub = awg_keys()
    psk = sh("awg genpsk").stdout.strip()
    hpk = sh("awg genkey").stdout.strip()

    srv = f"""[Interface]
Address = 10.99.0.1/24
ListenPort = 51821
PrivateKey = {spriv}
{params(hpk)}
[Peer]
PublicKey = {cpub}
PresharedKey = {psk}
AllowedIPs = 10.99.0.2/32
"""
    srvconf = os.path.join(work, "srv0.conf")
    with open(srvconf, "w") as f:
        f.write(srv)
    os.chmod(srvconf, 0o600)
    sh(f"ip netns exec srv awg-quick up {srvconf}")

    def client_conf(extra_iface=""):
        return f"""[Interface]
Address = 10.99.0.2/32
PrivateKey = {cpriv}
MTU = 1360
{params(hpk)}{extra_iface}
[Peer]
PublicKey = {spub}
PresharedKey = {psk}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 192.0.2.2:51821
PersistentKeepalive = 5-6
"""

    helper = subprocess.Popen([HELPER, "serve", "--uid", "0"], stderr=open(os.path.join(work, "helper.log"), "w"))
    try:
        for _ in range(50):
            if os.path.exists(SOCK):
                break
            time.sleep(0.1)
        check("служба запустилась и создала сокет", os.path.exists(SOCK))
        hello = call({"op": "hello"})
        check("hello: версия и состояние stopped", hello["ok"] and hello["version"] and hello["status"]["state"] == "stopped")
        st = os.stat(SOCK)
        check("сокет доступен только владельцу (0600)", (st.st_mode & 0o777) == 0o600, oct(st.st_mode & 0o777))

        # --- отклонение опасных запросов ---
        r = call({"op": "connect", "config": client_conf("PostUp = touch /tmp/pwned\n")})
        check("конфигурация со скриптом PostUp отклонена", not r["ok"] and r["error"]["code"] == "bad-config", json.dumps(r))
        check("скрипт не выполнялся", not os.path.exists("/tmp/pwned"))
        r = call({"op": "format-disk"})
        check("неизвестная операция отклонена", not r["ok"])
        r = call({"op": "connect", "config": client_conf(), "split": {"mode": "bypass", "apps": ["relative/../../etc/passwd"]}})
        check("недопустимый путь приложения отклонён", not r["ok"], json.dumps(r))

        # --- подключение с kill switch ---
        cfg = client_conf()
        r = call({"op": "connect", "config": cfg, "options": {"killSwitch": True, "allowLan": False}})
        check("connect принят", r["ok"], json.dumps(r))
        st = wait_status(lambda s: s["state"] == "running" and s["handshakeAgeSec"] is not None, 45)
        check("состояние running только после рукопожатия", st["state"] == "running" and st["handshakeAgeSec"] is not None, json.dumps(st))
        check("рукопожатие свежее", st["handshakeAgeSec"] is not None and st["handshakeAgeSec"] < 30)
        check("интерфейс privata0 создан", sh("ip link show privata0", check=False).returncode == 0)

        p1 = sh("ping -c3 -W2 10.99.0.1", check=False)
        check("ping сервера через туннель (10.99.0.1)", p1.returncode == 0, p1.stdout)
        p2 = sh("ping -c2 -W2 198.51.100.1", check=False)
        check("трафик в «интернет» идёт через туннель (полный туннель)", p2.returncode == 0, p2.stdout)
        route = sh("ip route get 198.51.100.1").stdout
        check("маршрут к «интернету» — через privata0", "dev privata0" in route, route)
        time.sleep(1.5)
        st2 = call({"op": "status"})["status"]
        check("счётчики трафика растут", st2["rxBytes"] > 0 and st2["txBytes"] > 0, json.dumps(st2))

        ks = sh("nft list table inet privata_ks", check=False)
        check("правила kill switch активны", ks.returncode == 0 and "drop" in ks.stdout and "192.0.2.2 udp dport 51821" in ks.stdout, ks.stdout + ks.stderr)
        leak = sh("ping -c1 -W1 192.0.2.2", check=False)
        check("вне туннеля трафик заблокирован (ping мимо туннеля не проходит)", leak.returncode != 0, leak.stdout)

        # --- повторное подключение (смена профиля) без параллельных туннелей ---
        r = call({"op": "connect", "config": cfg, "options": {"killSwitch": True, "allowLan": False}})
        check("повторный connect при активном туннеле принят", r["ok"], json.dumps(r))
        st = wait_status(lambda s: s["state"] == "running" and s["handshakeAgeSec"] is not None, 45)
        check("после переподключения снова рукопожатие", st["state"] == "running" and st["handshakeAgeSec"] is not None, json.dumps(st))
        n_if = len(re.findall(r"privata0", sh("ip -o link").stdout))
        check("интерфейс ровно один", n_if == 1, str(n_if))

        # --- авария туннеля: сеть остаётся заблокированной ---
        mine = os.readlink("/proc/self/ns/net")
        pid = [p for p in sh("pgrep -f 'amneziawg-go privata0'", check=False).stdout.split() if os.path.exists(f"/proc/{p}/ns/net") and os.readlink(f"/proc/{p}/ns/net") == mine]
        check("найден процесс amneziawg-go клиента", bool(pid))
        if pid:
            os.kill(int(pid[0]), signal.SIGKILL)
        st = wait_status(lambda s: s["state"] == "failed", 20)
        check("авария обнаружена: failed/tunnel-terminated", st["state"] == "failed" and st["errorCode"] == "tunnel-terminated", json.dumps(st))
        ks = sh("nft list table inet privata_ks", check=False)
        check("после аварии kill switch остаётся (fail-closed)", ks.returncode == 0, ks.stderr)
        leak = sh("ping -c1 -W1 192.0.2.2", check=False)
        check("после аварии утечки нет", leak.returncode != 0)

        # --- чистое отключение ---
        r = call({"op": "disconnect"})
        check("disconnect принят", r["ok"])
        st = wait_status(lambda s: s["state"] == "stopped", 30)
        check("состояние stopped", st["state"] == "stopped", json.dumps(st))
        check("интерфейс privata0 удалён", sh("ip link show privata0", check=False).returncode != 0)
        check("таблица kill switch удалена", sh("nft list table inet privata_ks", check=False).returncode != 0)
        check("файл конфигурации удалён", not os.path.exists("/run/privata-vpn/privata0.conf"))
        check("правила политики маршрутизации очищены", "51820" not in sh("ip rule show").stdout)
        back = sh("ping -c1 -W2 192.0.2.2", check=False)
        check("после отключения сеть работает как прежде", back.returncode == 0, back.stdout)

        # --- подключение без kill switch, с доступом к LAN ---
        r = call({"op": "connect", "config": cfg, "options": {"killSwitch": False, "allowLan": True}})
        st = wait_status(lambda s: s["state"] == "running" and s["handshakeAgeSec"] is not None, 45)
        check("подключение без kill switch", r["ok"] and st["state"] == "running" and st["handshakeAgeSec"] is not None, json.dumps(st))
        check("kill switch не создаётся, если он отключён", sh("nft list table inet privata_ks", check=False).returncode != 0)
        lan = sh("ping -c1 -W2 192.0.2.2", check=False)
        check("локальная сеть доступна (маршрут on-link приоритетнее)", lan.returncode == 0, lan.stdout)

        # --- раздельное туннелирование (cgroup v2 + nftables + политика маршрутизации) ---
        base = None
        m = re.search(r"0::(/.*?user@\d+\.service)", open("/proc/self/cgroup").read())
        if m:
            probe = "/sys/fs/cgroup" + m.group(1) + "/privata-probe"
            try:
                os.makedirs(probe)
                os.rmdir(probe)
                base = m.group(1).strip("/") + "/privata-vpn-e2e"
            except OSError:
                base = None
        if base is None:
            print("  – раздельное туннелирование: нет делегированной cgroup — проверено только юнит-тестами и разбором правил")
        else:
            call({"op": "disconnect"})
            wait_status(lambda s: s["state"] == "stopped", 30)
            call({"op": "shutdown"})
            helper.wait(timeout=10)
            os.environ["PRIVATA_CGROUP_DIR"] = base
            helper2 = subprocess.Popen([HELPER, "serve", "--uid", "0"], stderr=open(os.path.join(work, "helper2.log"), "w"))
            for _ in range(50):
                if os.path.exists(SOCK):
                    break
                time.sleep(0.1)
            appdir = os.path.join(work, "app")
            os.makedirs(appdir)
            app = os.path.join(appdir, "bypassping")
            shutil.copy(shutil.which("ping"), app)
            os.chmod(app, 0o755)
            # ping использует capability-бит на файле; в userns он нам не нужен (root), копия работает как есть

            def tx(dev):
                # /proc/net/dev учитывает текущий netns (в отличие от /sys/class/net в этом окружении)
                for line in open("/proc/net/dev"):
                    if line.strip().startswith(dev + ":"):
                        return int(line.split(":")[1].split()[9])
                raise RuntimeError(dev)

            def measure(cmd):
                proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(1.6)  # служба переносит процесс в cgroup (опрос каждые 0,5 с)
                v0, t0 = tx("veth0"), tx("privata0")
                time.sleep(3.0)
                v1, t1 = tx("veth0"), tx("privata0")
                proc.terminate()
                proc.wait()
                return v1 - v0, t1 - t0

            for mode, label in (("bypass", "bypass"), ("include", "include")):
                r = call({"op": "connect", "config": cfg, "options": {"killSwitch": False, "allowLan": False}, "split": {"mode": mode, "apps": [app]}})
                st = wait_status(lambda s: s["split"]["state"] in ("running", "failed") and s["state"] == "running", 45)
                check(f"[{label}] движок запущен", r["ok"] and st["split"]["state"] == "running", json.dumps(st))
                if st["split"]["state"] != "running":
                    call({"op": "disconnect"})
                    wait_status(lambda s: s["state"] == "stopped", 30)
                    continue
                check(f"[{label}] правила nft установлены", sh("nft list table ip privata_split", check=False).returncode == 0)
                check(f"[{label}] политика маршрутизации добавлена", "fwmark 0x5052" in sh("ip rule show").stdout, sh("ip rule show").stdout)
                listed = measure([app, "-i", "0.2", "198.51.100.1"])
                other = measure(["ping", "-i", "0.2", "198.51.100.1"])
                if mode == "bypass":
                    check("[bypass] выбранное приложение идёт мимо туннеля (veth0 растёт, privata0 нет)", listed[0] >= 10 and listed[1] <= 3, f"veth0 +{listed[0]}, privata0 +{listed[1]}")
                    check("[bypass] остальные приложения идут через туннель", other[1] >= 10 and other[0] <= 3, f"veth0 +{other[0]}, privata0 +{other[1]}")
                else:
                    check("[include] выбранное приложение идёт через туннель", listed[1] >= 10 and listed[0] <= 3, f"veth0 +{listed[0]}, privata0 +{listed[1]}")
                    check("[include] остальные приложения идут мимо туннеля", other[0] >= 10 and other[1] <= 3, f"veth0 +{other[0]}, privata0 +{other[1]}")
                call({"op": "disconnect"})
                wait_status(lambda s: s["state"] == "stopped", 30)
                check(f"[{label}] после отключения правила nft удалены", sh("nft list table ip privata_split", check=False).returncode != 0)
                check(f"[{label}] после отключения политика маршрутизации очищена", "0x5052" not in sh("ip rule show").stdout)
                check(f"[{label}] каталог cgroup удалён", not os.path.exists("/sys/fs/cgroup/" + base + "/apps"))
            call({"op": "shutdown"})
            helper2.wait(timeout=10)
            os.rmdir("/sys/fs/cgroup/" + base) if os.path.isdir("/sys/fs/cgroup/" + base) else None
            helper = subprocess.Popen([HELPER, "serve", "--uid", "0"], stderr=open(os.path.join(work, "helper3.log"), "w"))
            for _ in range(50):
                if os.path.exists(SOCK):
                    break
                time.sleep(0.1)

        r = call({"op": "recover"})
        check("recover выполнен", r["ok"], json.dumps(r))
        check("после recover интерфейса нет", sh("ip link show privata0", check=False).returncode != 0)
        r = call({"op": "shutdown"})
        check("shutdown принят", r["ok"])
        helper.wait(timeout=10)
        check("служба завершилась и убрала сокет", helper.returncode == 0 and not os.path.exists(SOCK), f"rc={helper.returncode}")
    finally:
        if helper.poll() is None:
            helper.send_signal(signal.SIGTERM)
            try:
                helper.wait(timeout=10)
            except subprocess.TimeoutExpired:
                helper.kill()
        sh(f"ip netns exec srv awg-quick down {srvconf}", check=False)
        print("--- журнал службы (последние строки) ---")
        print(open(os.path.join(work, "helper.log")).read()[-1500:])
        shutil.rmtree(work, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    print(f"\nИтого: {len(results) - len(failed)} из {len(results)} проверок пройдено")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
