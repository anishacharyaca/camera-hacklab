# How Our Camera Works

This document explains the current camera setup in simple words.

## The Short Version

The camera connects to a private Wi-Fi hotspot.

That hotspot is made by a Linux virtual machine. The camera can talk to our
Camera Hacklab dashboard and to a local clock server, but it cannot use the
internet.

We use this design because we do not trust the camera firmware enough to give
it unrestricted internet access.

## The Network

```text
Camera
  |
  | private hotspot Wi-Fi
  |
Hotspot VM / gateway
  - gives the camera an IP address
  - gives the camera the correct time
  - blocks internet access
  |
  | local access only
  |
Camera Hacklab computer
```

The Camera Hacklab computer currently uses two Wi-Fi connections:

- Its normal Wi-Fi connection provides internet for the computer.
- A second Wi-Fi adapter connects to the camera hotspot.

This keeps normal computer traffic separate from camera traffic.

## Why the VM Has a Time Server

The camera can lose or reset its clock after a restart or power loss.

Normally, the camera may try to contact an internet time server. We block the
camera from the internet, so that method cannot work.

To fix this, the hotspot VM runs its own local NTP time server. NTP is a
simple service that tells devices the correct time.

The camera is configured with:

```text
NTP enabled: yes
NTP server: hotspot gateway address
Timezone: Toronto / UTC-4 at the time of this check
DST switch: off, because this firmware already uses the active UTC offset
```

The camera can therefore fix its clock without going online. Correct time is
important because recording filenames and recording dates use the camera
clock.

## How Camera Hacklab Talks to the Camera

The Node.js server does not talk to a normal camera website.

It starts `homeeye_live_hevc.py`. That Python bridge loads the bundled PPCS
native library and connects to the camera using its DID, username, and
password.

```text
Web browser
    |
Node.js server
    |
Python camera bridge
    |
PPCS native library
    |
Camera
```

The same connection is used to:

- Read and change camera settings.
- Check and set the camera time.
- Start live video.
- Read SD-card status.
- List recordings.
- Download or delete recordings.
- Change recording modes.

## How Live Preview Works

The camera sends compressed HEVC video to the Python bridge.

Python passes that video to the Node.js server. Node starts `ffmpeg`, which
turns the HEVC stream into MJPEG images that a browser can display.

```text
Camera HEVC video -> Python -> Node -> ffmpeg -> browser preview
```

Live preview is not currently running. The dashboard server was also stopped
when this check was made. This does not mean the camera is offline; direct
camera control still works.

Start the dashboard with:

```bash
cd camera-hacklab
npm start
```

Then open:

```text
http://localhost:8787
```

## How Recordings Work

The camera records video onto its own SD card.

Camera Hacklab asks the camera for recording dates and filenames. When a video
is selected, the camera sends the file through the native PPCS connection.

The server can:

- Keep the original camera file.
- Extract raw HEVC video.
- Use `ffmpeg` to make a browser-friendly MP4.
- Generate and cache a thumbnail.
- Delete the recording from the camera.

Camera operations are handled one at a time because this camera can fail or
truncate data when several native transfers run together.

## Current Verified State

Example verified state:

- The camera hotspot path was connected.
- The hotspot VM answered on the private subnet gateway.
- The camera answered on the private camera subnet.
- The camera MAC was visible on the private camera network.
- The local NTP server answered on UDP port `123`.
- The NTP reply was within about `0.004` seconds of the computer clock.
- The camera reported `NTP enabled`.
- The camera reported the hotspot VM as its NTP server.
- The camera reported a current local time with the expected UTC offset.
- The camera SD card reported status `1`, meaning available.
- The SD card reported approximately `60,872 MB` total and `58,629 MB` free.
- The hotspot path could reach the VM and camera.
- The hotspot path could not reach public address `1.1.1.1`.
- The Camera Hacklab Node server and live preview were not running during the
  check.

## Why This Setup Is Safer

The camera gets only the local services it needs:

- Private Wi-Fi
- An IP address
- Local camera control
- Local time synchronization

It does not get a working route to the public internet. This reduces the chance
that unknown camera software can contact outside servers or send recordings
away from the local network.

The dashboard itself should also remain on a trusted local network because it
has no login screen and can control or delete camera recordings.
