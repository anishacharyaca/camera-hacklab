# Camera Hacklab Setup

The recommended setup path is now the **First-time Setup** workspace opened
automatically by the Node server:

```bash
npm run check
npm start
```

Open `http://localhost:8787` and follow the five stages shown in the browser.
The wizard validates camera credentials, scans or preserves Wi-Fi, guides
reconnection, verifies the SD/control path, synchronizes time, and applies the
initial recording policy.

When Linux is connected to an `AYSA-...` camera hotspot, the server detects the
SSID, uses it as the camera DID, and checks the normal factory credentials. It
then asks whether to:

- Keep using the camera hotspot. Camera Hacklab works normally, but Linux must
  reconnect to that hotspot whenever the camera is used.
- Move the camera to a private 2.4 GHz Wi-Fi network. Enter that network's
  credentials, keep the browser open, connect Linux to the same Wi-Fi after
  handoff, and run verification.

If hotspot mode is kept, the permanent **Setup** tab provides a **Set up camera
Wi-Fi** action so migration can be done later.

Using two Wi-Fi adapters is supported. One adapter can keep normal internet
access while the other joins the camera hotspot or private camera Wi-Fi. The
reconnect step lists every active adapter and SSID. If the camera is not found,
setup remains open with all values preserved; connect either adapter to the
correct network and select **Retry camera connection** as many times as needed.

This guide also covers the included shell automation. Use the script for a
headless installation, recovery, or deeper network troubleshooting.

The script changes the camera's Wi-Fi configuration. Use it only with a camera
you own or are authorized to configure.

## Isolated VM Hotspot

The development camera is not allowed to connect directly to the internet. We
do not trust the closed firmware or know every remote service it may contact,
so the camera joins a dedicated Wi-Fi hotspot hosted by a Linux virtual
machine.

```text
Camera
  |
  | private Wi-Fi
  v
Linux hotspot VM
  +-- DHCP and local network access
  +-- local NTP server
  +-- Camera Hacklab access
  `-- no forwarding to the internet
```

The VM hotspot provides:

- `hostapd` for the private camera Wi-Fi network.
- `dnsmasq` or another DHCP service for camera addressing.
- `chrony` or another NTP daemon listening on the private interface.
- Firewall rules that permit required local traffic but reject forwarding from
  the camera network to the internet.

The camera may lose or reset its date and time after power loss or reboot. On a
normal network it would attempt to correct that through an internet NTP server.
Blocking internet access exposed this behavior: the camera could not restore
its clock, which caused incorrect recording dates and setup warnings.

We resolved that problem by running a local NTP server inside the hotspot VM.
The camera can synchronize time with the VM while remaining unable to reach the
internet. The reprovision script also sends the current Linux time directly and
configures the camera's NTP server.

For a VM hotspot at `192.168.50.1`, use:

```text
TARGET_SUBNET_PREFIX: 192.168.50
NTP_SWITCH: 1
NTP_SERVER: 192.168.50.1
```

The exact VM, interface, and firewall configuration is deployment-specific.
The essential security rule is that the hotspot interface may reach local
Camera Hacklab and NTP services, but traffic from that interface must not be
forwarded or masqueraded to the public internet.

Example firewall policy:

```text
allow camera subnet -> VM UDP port 123       # local NTP
allow trusted LAN   -> camera subnet         # dashboard/control, if required
deny  camera subnet -> internet/WAN          # no external access
```

Do not rely only on DNS blocking. A camera can connect to hard-coded IP
addresses. Enforce isolation with routing and firewall rules at the VM or
gateway.

## Requirements

- Linux with NetworkManager and `nmcli`
- Python 3.9 or newer
- Standard commands: `ip`, `ping`, `awk`, `sed`, `seq`, and `xargs`
- Camera Hacklab's bundled Python bridge and native libraries
- A supported camera in AP/setup mode
- A 2.4 GHz target Wi-Fi network
- The camera DID, login, MAC address, and target Wi-Fi credentials

If you are starting from a public repository clone and the bundled PPCS
library is not present yet, restore it before running the dashboard:

1. Download the `HomeEye` Android package with package name
   `shix.homeeye.camera`.
2. Prefer the official app page first:
   `https://play.google.com/store/apps/details?id=shix.homeeye.camera`
3. If needed, obtain the APK from another public mirror and verify the package
   name before using it.
4. Run:

```bash
scripts/install-native.sh /path/to/base.apk
```

The script accepts either a camera APK/ZIP archive or an unpacked directory
that already contains `apk_extract/lib/arm64-v8a/libPPCS_API.so`.
After that, run `npm run check` before starting setup.

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y network-manager python3 iproute2 iputils-ping findutils
```

## 1. Create the Local Configuration

From the `camera-hacklab` directory:

```bash
cp setup/camera.conf.example setup/camera.conf
chmod 600 setup/camera.conf
```

Edit `setup/camera.conf` and replace all example values:

```text
CAMERA_AP_PREFIX: AYSA-
CAMERA_DID: AYSA-YOUR-CAMERA-DID
CAMERA_USER: admin
CAMERA_PASSWORD: 6666
CAMERA_MAC: 00:11:22:33:44:55
CAMERA_TIMEZONE: America/Toronto
TARGET_SSID: YOUR-2.4GHZ-WIFI
TARGET_PASSWORD: YOUR-WIFI-PASSWORD
TARGET_ENCRYPTION: 0
TARGET_SUBNET_PREFIX: 192.168.1
TARGET_SCAN_START: 2
TARGET_SCAN_END: 254
NTP_SWITCH: 1
NTP_SERVER: 192.168.1.1
```

`setup/camera.conf` is ignored by Git because it contains camera and Wi-Fi
credentials. Commit only `camera.conf.example`.

### Configuration fields

| Field | Meaning |
| --- | --- |
| `CAMERA_AP_PREFIX` | Prefix of the camera's temporary setup SSID |
| `CAMERA_DID` | Camera P2P identifier |
| `CAMERA_USER` | Camera login username |
| `CAMERA_PASSWORD` | Camera login password |
| `CAMERA_MAC` | Camera Wi-Fi MAC used to find its new IP |
| `CAMERA_TIMEZONE` | IANA timezone used for clock synchronization |
| `TARGET_SSID` | Destination 2.4 GHz Wi-Fi SSID |
| `TARGET_PASSWORD` | Destination Wi-Fi password |
| `TARGET_ENCRYPTION` | Camera firmware's numeric Wi-Fi security code |
| `TARGET_SUBNET_PREFIX` | First three octets of the destination IPv4 subnet |
| `TARGET_SCAN_START` | First host number checked during discovery |
| `TARGET_SCAN_END` | Last host number checked during discovery |
| `NTP_SWITCH` | `1` enables camera NTP; `0` disables it |
| `NTP_SERVER` | Local NTP server address sent to the camera |

The encryption value is a camera protocol code, not a human-readable security
name. `0` worked with the development camera's WPA2 hotspot, but firmware can
interpret codes differently. If possible, first inspect the camera's
`--scan-wifi` response or retain the value known to work with your firmware.

## 2. Prepare the Camera and Linux Host

1. Stop Camera Hacklab if it is running.
2. Close the original camera app so it does not hold another camera session.
3. Reset the camera if necessary to restore its `AYSA-...` setup hotspot.
4. Connect the Linux host to the camera hotspot.
5. If continuous internet is needed, use a second Wi-Fi adapter or Ethernet.

Check the active connection:

```bash
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status
```

## 3. Run the Automation

Make the script executable if needed, then run it from the project root:

```bash
chmod +x setup/reprovision_camera.sh
./setup/reprovision_camera.sh
```

The script deliberately pauses twice:

1. It confirms that Linux is connected to the camera hotspot before changing
   the camera network.
2. After sending the handoff, it waits for you to connect Linux to the target
   Wi-Fi before verification.

The script does not switch Linux network interfaces automatically. This avoids
disconnecting the wrong adapter or removing the only working internet path.

## What the Script Does

1. Validates required commands, configuration, bridge, and native libraries.
2. Displays Linux network-interface state.
3. Sends the `set_wifi` command with the target SSID, password, and encryption
   code.
4. Waits for manual reconnection of Linux to the target Wi-Fi.
5. Detects the interface connected to the target SSID.
6. Pings the configured subnet range to populate the neighbor table.
7. Finds the camera IP by its configured MAC address.
8. Runs an SD-status query to verify the PPCS/native control path.
9. Sends current epoch, timezone offset, `dstSwitch=0`, hour, and optional NTP
   settings.
10. Reads the camera datetime back and prints the result.

The bundled compatibility-library path is exported automatically. You do not
need to set `LD_LIBRARY_PATH` manually.

## Use a Different Config File

Set `CAMERA_CONFIG` to provision multiple cameras without replacing the default
local config:

```bash
CAMERA_CONFIG="$HOME/private/camera-bedroom.conf" ./setup/reprovision_camera.sh
```

The alternate file uses the same `KEY: value` format.

## After Successful Migration

Start the Node dashboard:

```bash
npm start
```

Open `http://localhost:8787`, enter the same DID and camera credentials under
**Edit settings**, apply them, and test live preview and SD status.

The camera's IP address is used only for local discovery confirmation. Normal
dashboard control continues to identify the camera by DID through the bundled
PPCS library.

## Recovery and Troubleshooting

### The camera hotspot disappears

This is expected immediately after `set_wifi`. Connect Linux to the target
network and continue when prompted.

### No interface is found on the target SSID

Connect Linux to the exact configured `TARGET_SSID`, then rerun the script.
Quoted, hidden, or unusual SSID characters may not be handled by the simple
NetworkManager output parser.

### The camera MAC is not found

- Wait one or two minutes for camera startup.
- Verify `CAMERA_MAC`.
- Verify `TARGET_SUBNET_PREFIX` and the scan range.
- Check the router or hotspot DHCP-client list.
- Confirm the target network is 2.4 GHz.
- Reset the camera and retry if it never joins.

### Native verification fails

- Stop all live previews and vendor-app sessions.
- Verify DID, username, and password.
- Confirm the bundled `.so` files are present.
- Run the dashboard diagnostics after restarting the server.

### Wi-Fi handoff used the wrong credentials

The camera usually cannot be corrected after it leaves AP mode but fails to
join the target. Hardware-reset it, reconnect Linux to its setup hotspot,
correct `setup/camera.conf`, and rerun the script.

### NTP is unavailable

Set:

```text
NTP_SWITCH: 0
NTP_SERVER: 0.0.0.0
```

The script still sends the current Linux time and timezone directly.

For an isolated hotspot, the better fix is to run NTP locally in the hotspot
VM and set `NTP_SERVER` to that VM's private hotspot address. This preserves
correct recording dates after camera restarts without granting internet
access.

## Manual Commands

Scan networks visible to the camera:

```bash
LD_LIBRARY_PATH="$PWD/android_compat_libs" \
python3 homeeye_live_hevc.py \
  --did "YOUR-DID" --user "admin" --pwd "6666" \
  --scan-wifi --quiet
```

Read camera time:

```bash
LD_LIBRARY_PATH="$PWD/android_compat_libs" \
python3 homeeye_live_hevc.py \
  --did "YOUR-DID" --user "admin" --pwd "6666" \
  --get-datetime-auto --quiet
```

Use these commands for diagnosis only. The automation script is the preferred
path because it also performs discovery, verification, and clock setup.
