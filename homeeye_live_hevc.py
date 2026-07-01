#!/usr/bin/env python3
import argparse
import ctypes
import datetime as dt
import json
import re
import os
import queue
import signal
import struct
import subprocess
import sys
import time
import threading
import urllib.parse
from pathlib import Path
from contextlib import suppress


SERVER = (
    b"EBGJFNBBKJJEGIJHEGHMFBENHMNGHHMBHOFEBKDFAPJNLAKEDAAADGPGGLKFIKLJANNHKEDLOONOBMCGIO"
    b":JX20130716"
)
FRAME_MAGIC = b"\x54\xaa\x15\xa8"
FRAME_HEADER_LEN = 32
GST_SECOND = 1_000_000_000
ROOT = Path(__file__).resolve().parent
ANDROID_LIBS = ROOT / "android_compat_libs"
LD_ENV_MARKER = "HOME_EYE_LD_PREPENDED"


def shix_packet(payload, cmd_a=0x0A06, cmd_b=0x80A0):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return struct.pack("<HHI", cmd_a, cmd_b, len(raw)) + raw


def load_ppcs():
    lib = ctypes.CDLL(str(ROOT / "apk_extract/lib/arm64-v8a/libPPCS_API.so"))
    lib.PPCS_Initialize.argtypes = [ctypes.c_char_p]
    lib.PPCS_Initialize.restype = ctypes.c_int
    lib.PPCS_Connect.argtypes = [ctypes.c_char_p, ctypes.c_char, ctypes.c_ushort]
    lib.PPCS_Connect.restype = ctypes.c_int
    lib.PPCS_Write.argtypes = [ctypes.c_int, ctypes.c_ubyte, ctypes.c_char_p, ctypes.c_int]
    lib.PPCS_Write.restype = ctypes.c_int
    lib.PPCS_Read.argtypes = [
        ctypes.c_int,
        ctypes.c_ubyte,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
    ]
    lib.PPCS_Read.restype = ctypes.c_int
    lib.PPCS_Check_Buffer.argtypes = [
        ctypes.c_int,
        ctypes.c_ubyte,
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int),
    ]
    lib.PPCS_Check_Buffer.restype = ctypes.c_int
    lib.PPCS_Close.argtypes = [ctypes.c_int]
    lib.PPCS_Close.restype = ctypes.c_int
    lib.PPCS_DeInitialize.restype = ctypes.c_int
    return lib


def write_command(lib, handle, payload):
    data = shix_packet(payload)
    ret = lib.PPCS_Write(handle, 0, data, len(data))
    if ret < 0:
        raise RuntimeError(f"PPCS_Write failed: {ret}")
    return ret


def request_iframe(lib, handle, index):
    payload = {
        "pro": "get_Idr",
        "cmd": 105,
        "user": "admin",
        "pwd": "6666",
        "ch": index,
        "index": index,
    }
    return write_command(lib, handle, payload)


def parse_set_param(value):
    if "=" not in value:
        raise argparse.ArgumentTypeError("--set-param must look like name=value")
    key, raw = value.split("=", 1)
    key = key.strip()
    raw = raw.strip()
    if not key:
        raise argparse.ArgumentTypeError("--set-param name cannot be empty")
    try:
        parsed = int(raw, 0)
    except ValueError:
        parsed = raw
    return key, parsed


def send_set_params(lib, handle, user, pwd, params):
    payload = {
        "pro": "set_parms",
        "cmd": 103,
        "user": user,
        "pwd": pwd,
    }
    payload.update(dict(params))
    return write_command(lib, handle, payload)


def send_set_record_param(lib, handle, user, pwd, params):
    payload = {
        "pro": "set_record_param",
        "cmd": 0x7A,
        "user": user,
        "pwd": pwd,
    }
    payload.update(dict(params))
    return write_command(lib, handle, payload)


RECORD_MODE_MAP = {
    "privacy": 0,
    "full_day": 1,
    "alarm": 2,
    "timed": 3,
}


def send_set_timed_record_para(lib, handle, user, pwd, payload_obj):
    payload = {
        "pro": "set_timed_record_para",
        "cmd": 0x1D4,
        "user": user,
        "pwd": pwd,
    }
    payload.update(payload_obj)
    return write_command(lib, handle, payload)


def normalize_record_list_date(value):
    text = str(value or "").strip()
    if re.fullmatch(r"\d{8}", text):
        return f"{text[:4]}_{text[4:6]}_{text[6:8]}"
    return text


def send_dev_control(lib, handle, user, pwd, params):
    payload = {
        "pro": "dev_control",
        "cmd": 0x66,
        "user": user,
        "pwd": pwd,
    }
    payload.update(dict(params))
    return write_command(lib, handle, payload)


def send_json_query(lib, handle, user, pwd, pro, cmd):
    return write_command(
        lib,
        handle,
        {
            "pro": pro,
            "cmd": cmd,
            "user": user,
            "pwd": pwd,
        },
    )


def read_control_reply(lib, handle, channels=(0, 1), timeout=2.5, min_idle=0.5):
    deadline = time.time() + timeout
    buf = bytearray()
    last_data = 0.0
    while time.time() < deadline:
        made_progress = False
        for channel in channels:
            read_size = 4096
            try:
                write_buffer = ctypes.c_int()
                read_buffer = ctypes.c_int()
                check_ret = lib.PPCS_Check_Buffer(
                    handle,
                    ctypes.c_ubyte(channel),
                    ctypes.byref(write_buffer),
                    ctypes.byref(read_buffer),
                )
                if check_ret == 0 and read_buffer.value > 0:
                    read_size = min(max(read_size, read_buffer.value), 65536)
            except Exception:
                pass

            cbuf = ctypes.create_string_buffer(read_size)
            size = ctypes.c_int(len(cbuf))
            ret = lib.PPCS_Read(
                handle,
                ctypes.c_ubyte(channel),
                cbuf,
                ctypes.byref(size),
                250,
            )
            if (ret >= 0 or (ret == -3 and size.value > 0)) and size.value > 0:
                buf.extend(bytes(cbuf.raw[: size.value]))
                last_data = time.time()
                made_progress = True
        if buf and (time.time() - last_data) >= min_idle:
            break
        if not made_progress:
            time.sleep(0.05)
    return bytes(buf)


def decode_sd_reply(data):
    text = data.decode("utf-8", errors="ignore")
    stripped = text.strip("\x00\r\n\t ")
    result = {
        "raw_text": stripped,
        "raw_length": len(data),
    }
    parsed_candidates = []
    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\{\[]", stripped):
        with suppress(Exception):
            parsed, _ = decoder.raw_decode(stripped[match.start():])
            if isinstance(parsed, dict):
                parsed_candidates.append(parsed)
    if parsed_candidates:
        # A read can contain the login reply, the requested payload, and a
        # trailing acknowledgement. Prefer the frame carrying the most data;
        # choosing the final JSON frame often selects only {"cmd", "result"}.
        result["json"] = max(
            parsed_candidates,
            key=lambda item: (
                "record_num" in item,
                any(key.startswith(("record_name[", "month[")) for key in item),
                item.get("cmd") == 0xD0,
                item.get("cmd") != 100,
                len(item),
            ),
        )
    return result


def send_get_datetime(lib, handle, user, pwd, cmd=0x7D):
    payload = {
        "pro": "get_datetime",
        "cmd": cmd,
        "user": user,
        "pwd": pwd,
    }
    return write_command(lib, handle, payload)


def send_set_datetime(lib, handle, user, pwd, fields, cmd=0x7E):
    payload = {
        "pro": "set_datetime",
        "cmd": cmd,
        "user": user,
        "pwd": pwd,
    }
    payload.update(fields)
    return write_command(lib, handle, payload)


def send_scan_wifi(lib, handle, user, pwd):
    payload = {
        "pro": "scan_wifi",
        "cmd": 0x71,
        "user": user,
        "pwd": pwd,
    }
    return write_command(lib, handle, payload)


def send_set_wifi(lib, handle, user, pwd, ssid, wifi_pwd, encryption):
    payload = {
        "pro": "set_wifi",
        "cmd": 0x72,
        "user": user,
        "pwd": pwd,
        "wifissid": urllib.parse.quote_plus(ssid, encoding="utf-8"),
        "wifipwd": urllib.parse.quote_plus(wifi_pwd, encoding="utf-8"),
        "encryption": encryption,
    }
    return write_command(lib, handle, payload)


def decode_scan_wifi_reply(data):
    decoded = decode_sd_reply(data)
    result = {
        "raw_text": decoded.get("raw_text", ""),
        "raw_length": decoded.get("raw_length", len(data)),
        "networks": [],
    }
    payload = decoded.get("json")
    if not isinstance(payload, dict):
        return result

    result["json"] = payload
    count = 0
    for key in payload:
        if key.startswith("ssid[") and key.endswith("]"):
            with suppress(ValueError):
                count = max(count, int(key[5:-1]) + 1)

    networks = []
    for idx in range(count):
        ssid = payload.get(f"ssid[{idx}]")
        if ssid is None:
            continue
        networks.append(
            {
                "index": idx,
                "ssid": str(ssid),
                "signal": payload.get(f"signal[{idx}]"),
                "encryption": payload.get(f"encryption[{idx}]"),
            }
        )
    result["networks"] = networks
    return result


def decode_datetime_reply(data):
    decoded = decode_sd_reply(data)
    result = {
        "raw_text": decoded.get("raw_text", ""),
        "raw_length": decoded.get("raw_length", len(data)),
    }
    payload = decoded.get("json")
    if not isinstance(payload, dict):
        return result

    result["json"] = payload
    if isinstance(payload.get("time"), int) and payload["time"] >= MIN_VALID_CAMERA_EPOCH:
        with suppress(Exception):
            result["time_iso_local"] = dt.datetime.fromtimestamp(payload["time"]).astimezone().isoformat()
        with suppress(Exception):
            result["time_iso_utc"] = dt.datetime.fromtimestamp(payload["time"], dt.timezone.utc).isoformat()
    return result


def build_phone_timezone_fields():
    now = dt.datetime.now().astimezone()
    offset = now.utcoffset() or dt.timedelta(0)
    tz_seconds = int(offset.total_seconds())
    tz_hours = tz_seconds / 3600.0
    return {
        "timeZone": tz_hours,
        "timeZone_Sec": tz_seconds,
    }


QUALITY_TO_STREAM = {
    "hd": 2,
    "fhd": 1,
}

MIN_VALID_CAMERA_EPOCH = 1577836800


class HomeEyeFrameStripper:
    def __init__(self):
        self.buf = bytearray()
        self.last_seq = None
        self.gaps = []

    def feed_frames(self, chunk):
        self.buf.extend(chunk)
        frames = []

        while True:
            first = self.buf.find(FRAME_MAGIC)
            if first < 0:
                self.buf = self.buf[-3:]
                break
            if first:
                del self.buf[:first]

            if len(self.buf) < FRAME_HEADER_LEN:
                break

            payload_len = struct.unpack_from("<I", self.buf, 16)[0]
            if payload_len <= 0 or payload_len > 4 * 1024 * 1024:
                del self.buf[: len(FRAME_MAGIC)]
                continue

            frame_len = FRAME_HEADER_LEN + payload_len
            if len(self.buf) < frame_len:
                break

            next_magic = self.buf.find(FRAME_MAGIC, len(FRAME_MAGIC))
            if next_magic < 0:
                break

            # Some HomeEye frames report a shorter payload length than the
            # actual HEVC access unit. Trust the length only when it lands on
            # the next frame boundary; otherwise use the next magic marker.
            if frame_len != next_magic:
                frame_len = next_magic

            frame_type = self.buf[4]
            seq = struct.unpack_from("<I", self.buf, 12)[0]
            if self.last_seq is not None and seq != self.last_seq + 1:
                self.gaps.append((self.last_seq, seq))
            self.last_seq = seq

            frames.append(
                {
                    "payload": bytes(self.buf[FRAME_HEADER_LEN:frame_len]),
                    "keyframe": frame_type == 0,
                    "seq": seq,
                }
            )
            del self.buf[:frame_len]

        return frames

    def feed(self, chunk):
        return b"".join(frame["payload"] for frame in self.feed_frames(chunk))

    def flush(self):
        if len(self.buf) > FRAME_HEADER_LEN and self.buf.startswith(FRAME_MAGIC):
            payload = bytes(self.buf[FRAME_HEADER_LEN:])
            self.buf.clear()
            return payload
        return b""


class HomeEyeDownloadStripper:
    """Remove the fixed 32-byte wrapper from native download_file packets."""

    def __init__(self):
        self.buf = bytearray()
        self.total_size = 0
        self.last_seq = None

    def feed(self, chunk):
        self.buf.extend(chunk)
        payloads = []
        while True:
            first = self.buf.find(FRAME_MAGIC)
            if first < 0:
                self.buf = self.buf[-3:]
                break
            if first:
                del self.buf[:first]
            if len(self.buf) < FRAME_HEADER_LEN:
                break
            payload_len = struct.unpack_from("<I", self.buf, 16)[0]
            if payload_len <= 0 or payload_len > 4 * 1024 * 1024:
                del self.buf[: len(FRAME_MAGIC)]
                continue
            packet_len = FRAME_HEADER_LEN + payload_len
            if len(self.buf) < packet_len:
                break
            self.last_seq = struct.unpack_from("<I", self.buf, 12)[0]
            declared_total = struct.unpack_from("<I", self.buf, 28)[0]
            if declared_total > 0:
                self.total_size = declared_total
            payloads.append(bytes(self.buf[FRAME_HEADER_LEN:packet_len]))
            del self.buf[:packet_len]
        return payloads


def hevc_nal_types(data):
    i = 0
    while True:
        start = data.find(b"\x00\x00\x01", i)
        prefix_len = 3
        if start >= 1 and data[start - 1] == 0:
            start -= 1
            prefix_len = 4
        if start < 0:
            return
        nal = start + prefix_len
        if nal < len(data):
            yield (data[nal] >> 1) & 0x3F
        i = nal + 1


def has_clean_hevc_start(data):
    nal_types = set(hevc_nal_types(data))
    return bool(nal_types.intersection({19, 20, 32, 33, 34}))


def split_hevc_annexb(data):
    starts = []
    i = 0
    while True:
        start = data.find(b"\x00\x00\x01", i)
        prefix_len = 3
        if start >= 1 and data[start - 1] == 0:
            start -= 1
            prefix_len = 4
        if start < 0:
            break
        starts.append((start, prefix_len))
        i = start + prefix_len + 1

    for index, (start, prefix_len) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else len(data)
        nal_start = start + prefix_len
        if nal_start >= end:
            continue
        nal_type = (data[nal_start] >> 1) & 0x3F
        yield nal_type, data[start:end]


def extract_hevc_config(data):
    parts = []
    seen = set()
    for nal_type, nal in split_hevc_annexb(data):
        if nal_type in (32, 33, 34) and nal_type not in seen:
            parts.append(nal)
            seen.add(nal_type)
    if len(seen) == 3:
        return b"".join(parts)
    return b""


class BufferedWriter:
    def __init__(self, stream, max_items=8):
        self.stream = stream
        self.queue = queue.Queue(maxsize=max_items)
        self.stop = object()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            item = self.queue.get()
            if item is self.stop:
                break
            try:
                self.stream.write(item)
                self.stream.flush()
            except BrokenPipeError:
                break

    def write(self, data):
        try:
            self.queue.put_nowait(data)
        except queue.Full:
            try:
                _ = self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(data)
            except queue.Full:
                pass

    def flush(self):
        pass

    def close(self):
        try:
            self.queue.put_nowait(self.stop)
        except queue.Full:
            pass
        self.thread.join(timeout=2)
        try:
            self.stream.close()
        except Exception:
            pass


class GstAppSrcPlayer:
    def __init__(self, args):
        try:
            import gi

            gi.require_version("Gst", "1.0")
            gi.require_version("GLib", "2.0")
            from gi.repository import Gst, GLib
        except Exception as exc:
            raise RuntimeError(
                "GStreamer Python bindings are required for --player gst"
            ) from exc

        self.Gst = Gst
        self.GLib = GLib
        Gst.init(None)

        decoder = "vaapih265dec" if args.gst_decoder == "vaapi" else "avdec_h265"
        sink = "ximagesink"
        pipeline_desc = (
            "appsrc name=src is-live=true block=false format=time do-timestamp=false max-bytes=0 "
            'caps="video/x-h265,stream-format=byte-stream,alignment=au,width=1920,height=1080,framerate=15/1,pixel-aspect-ratio=1/1" '
            "! queue max-size-buffers=0 max-size-bytes=0 max-size-time=3000000000 "
            f"! h265parse disable-passthrough=true config-interval=-1 ! {decoder} "
            f"! queue max-size-buffers=4 max-size-bytes=0 max-size-time=0 leaky=downstream "
            f"! videoconvert ! {sink} sync=false async=false"
        )

        self.pipeline = Gst.parse_launch(pipeline_desc)
        self.appsrc = self.pipeline.get_by_name("src")
        if self.appsrc is None:
            raise RuntimeError("failed to create GStreamer appsrc")

        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_bus_message)

        self.pipeline.set_state(Gst.State.PLAYING)
        self.loop = GLib.MainLoop()
        self.loop_thread = threading.Thread(target=self.loop.run, daemon=True)
        self.loop_thread.start()
        self.closed = False
        self.queue = queue.Queue(maxsize=args.player_queue)
        self.args_fps = args.fps
        self.frame_duration = GST_SECOND // args.fps
        self.frame_index = 0
        self.next_push_time = time.monotonic()
        self.push_thread = threading.Thread(target=self._push_loop, daemon=True)
        self.push_thread.start()

    def _on_bus_message(self, bus, message):
        mtype = message.type
        if mtype == self.Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            print(f"gst_error={err.message}", file=sys.stderr)
            if debug and debug.strip():
                print(f"gst_debug={debug}", file=sys.stderr)
        elif mtype == self.Gst.MessageType.WARNING:
            err, debug = message.parse_warning()
            print(f"gst_warning={err.message}", file=sys.stderr)
            if debug and debug.strip():
                print(f"gst_debug={debug}", file=sys.stderr)

    def write(self, data):
        if self.closed or not data:
            return
        try:
            self.queue.put_nowait(data)
        except queue.Full:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(data)
            except queue.Full:
                pass

    def _push_loop(self):
        while True:
            data = self.queue.get()
            if data is None:
                return
            if self.closed:
                return
            now = time.monotonic()
            if self.next_push_time > now:
                time.sleep(self.next_push_time - now)
            self.next_push_time = max(self.next_push_time + (1.0 / self.args_fps), time.monotonic())
            buf = self.Gst.Buffer.new_allocate(None, len(data), None)
            buf.fill(0, data)
            buf.pts = self.frame_index * self.frame_duration
            buf.dts = buf.pts
            buf.duration = self.frame_duration
            self.frame_index += 1
            ret = self.appsrc.emit("push-buffer", buf)
            if ret not in (self.Gst.FlowReturn.OK, self.Gst.FlowReturn.FLUSHING):
                print(f"gst_push={ret}", file=sys.stderr)

    def flush(self):
        return

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass
        try:
            self.appsrc.emit("end-of-stream")
        except Exception:
            pass
        try:
            self.loop.quit()
        except Exception:
            pass
        self.pipeline.set_state(self.Gst.State.NULL)


def open_sink(args):
    if args.out == "-":
        return sys.stdout.buffer, None
    if args.player:
        if args.player == "gst":
            player = GstAppSrcPlayer(args)
            return player, None

        player_stderr = subprocess.DEVNULL if args.quiet else None
        proc = subprocess.Popen(
            [
                args.player,
                "-hide_banner",
                "-loglevel",
                "warning",
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-analyzeduration",
                "0",
                "-probesize",
                "32",
                "-framedrop",
                "-sync",
                "video",
                "-f",
                "hevc",
                "-i",
                "-",
            ],
            stdin=subprocess.PIPE,
                stderr=player_stderr,
            )
        return proc.stdin, proc
    return open(args.out, "wb"), None


def main():
    if not os.environ.get(LD_ENV_MARKER):
        env = os.environ.copy()
        current = env.get("LD_LIBRARY_PATH", "")
        parts = [str(ANDROID_LIBS)]
        if current:
            parts.append(current)
        env["LD_LIBRARY_PATH"] = ":".join(parts)
        env[LD_ENV_MARKER] = "1"
        os.execvpe(sys.executable, [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]], env)

    parser = argparse.ArgumentParser(
        description="View or save live HEVC video from a HomeEye/SHIX PPCS camera."
    )
    parser.add_argument("--did", default="")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--pwd", default="")
    parser.add_argument("--stream", type=int, default=1, help="Raw stream id. The app uses 1 for FHD and 2 for HD on this camera.")
    parser.add_argument("--quality", choices=sorted(QUALITY_TO_STREAM), default="", help="App-style live quality selector: hd=stream 2, fhd=stream 1")
    parser.add_argument("--seconds", type=float, default=0, help="0 means run until Ctrl+C")
    parser.add_argument("--out", default="homeeye_live.hevc", help="Use '-' for stdout")
    parser.add_argument("--player", default="", help="Example: ffplay or gst")
    parser.add_argument("--login-time-mode", choices=["omit", "current", "zero"], default="omit", help="How to populate check_user time before streaming")
    parser.add_argument("--gst-decoder", default="software", choices=["vaapi", "software"], help="Decoder for --player gst")
    parser.add_argument("--player-queue", type=int, default=120, help="Number of encoded chunks to buffer before dropping old playback data")
    parser.add_argument("--fps", type=int, default=15, help="Playback frame rate for raw camera frames")
    parser.add_argument("--read-chunk", type=int, default=65536, help="Minimum PPCS read buffer size")
    parser.add_argument("--max-read-chunk", type=int, default=2097152, help="Maximum PPCS read buffer size")
    parser.add_argument("--read-timeout", type=int, default=1000, help="PPCS_Read timeout in milliseconds")
    parser.add_argument("--check-buffer", action="store_true", help="Experimental: query PPCS read-buffer size before reading")
    parser.add_argument("--verbose", action="store_true", default=True, help="Print stream progress and SDK events")
    parser.add_argument("--quiet", action="store_true", help="Suppress script and player logging")
    parser.add_argument("--no-iframe", action="store_true", help="Skip initial keyframe request")
    parser.add_argument("--iframe-interval", type=float, default=2.0, help="Seconds between recovery keyframe requests; 0 disables repeats")
    parser.add_argument("--no-iframe-on-gap", action="store_true", help="Do not request a fresh I-frame after a detected stream sequence gap")
    parser.add_argument("--gap-iframe-threshold", type=int, default=20, help="Only request a recovery I-frame after a gap this many frames or larger")
    parser.add_argument("--no-wait-keyframe", action="store_true", help="Start output immediately instead of waiting for VPS/SPS/PPS/IDR")
    parser.add_argument("--set-param", action="append", type=parse_set_param, default=[], help="Send set_parms before streaming, for example video_resolution=1")
    parser.add_argument("--night-vision-mode", type=int, choices=[0, 1, 2, 3], default=None, help="Send dev_control night vision mode: 0=off, 1=on, 2=auto, 3=auto color")
    parser.add_argument("--record-video", type=int, choices=[0, 1], default=None, help="Send set_record_param videoRecord: 0=off, 1=on")
    parser.add_argument("--record-mode", choices=sorted(RECORD_MODE_MAP), default=None, help="Send timedrecord_programme: privacy, full_day, alarm, or timed")
    parser.add_argument("--wakeup-mode", type=int, choices=[0, 1, 2], default=None, help="Send set_record_param wakeup_mode: 0=turn off sleep, 1=timed wake up, 2=alarm wake up")
    parser.add_argument("--record-sound", type=int, choices=[0, 1], default=None, help="Send set_record_param record_sound: 0=off, 1=on")
    parser.add_argument("--record-sound-during-wake-up-period", type=int, choices=[0, 1], default=None, help="Send set_record_param record_sound_during_wake_up_period: 0=off, 1=on")
    parser.add_argument("--loop-coverage", type=int, choices=[0, 1], default=None, help="Send set_record_param loop_coverage: 0=off, 1=on")
    parser.add_argument("--sd-card-recording-duration", type=int, default=None, help="Send set_record_param sd_card_recording_duration_minutes")
    parser.add_argument("--alarm-recording-duration", type=int, default=None, help="Send set_record_param alarm_recording_duration_s")
    parser.add_argument("--alarm-recording-interval", type=int, default=None, help="Send set_record_param alarm_recording_interval_s")
    parser.add_argument("--timed-record-start", default="", help="Timed recording start time HH:MM")
    parser.add_argument("--timed-record-end", default="", help="Timed recording end time HH:MM")
    parser.add_argument("--timed-record-days", default="", help="Timed recording days as 7-bit mask or comma-separated weekday numbers")
    parser.add_argument("--timed-record-enable", type=int, choices=[0, 1], default=None, help="Timed recording day switch")
    parser.add_argument("--low-power-mode", type=int, choices=[0, 1, 2], default=None, help="App low power mode: 0=auto, 1=open, 2=close")
    parser.add_argument("--apply-only", action="store_true", help="Send control settings and exit without opening the live stream")
    parser.add_argument("--sd-status", action="store_true", help="Query SD card status and exit")
    parser.add_argument("--sd-record-day", type=int, default=None, help="Query record days for a year and exit")
    parser.add_argument("--sd-record-list", default="", help="Query record list for a YYYYMMDD date and exit")
    parser.add_argument("--record-play-file", default="", help="Play/download a camera recording by filename and write HEVC to --out")
    parser.add_argument("--record-download-file", default="", help="Use the camera's native download_file command and write its response to --out")
    parser.add_argument("--delete-record-file", default="", help="Delete one camera recording by filename and exit")
    parser.add_argument("--record-play-offset", type=int, default=0, help="Recording playback offset")
    parser.add_argument("--scan-wifi", action="store_true", help="Ask the camera to scan nearby Wi-Fi networks and print the results")
    parser.add_argument("--set-wifi-ssid", default="", help="Set the camera Wi-Fi target SSID")
    parser.add_argument("--set-wifi-pwd", default="", help="Set the camera Wi-Fi target password")
    parser.add_argument("--set-wifi-encryption", type=int, default=None, help="Set the camera Wi-Fi target encryption code")
    parser.add_argument("--set-param-delay", type=float, default=1.0, help="Seconds to wait after set_parms before starting stream")
    parser.add_argument("--get-datetime", action="store_true", help="Send get_datetime to the device")
    parser.add_argument("--get-datetime-auto", action="store_true", help="Send AP-mode get_datetime command used by the app (cmd 0x17ed)")
    parser.add_argument("--get-parms-auto", action="store_true", help="Send AP-mode get_parms command used by the app (cmd 0x17d5)")
    parser.add_argument("--get-record-param", action="store_true", help="Send get_record_param to the device")
    parser.add_argument("--get-timed-record-para", action="store_true", help="Send get_timed_record_para to the device")
    parser.add_argument("--set-datetime-auto", action="store_true", help="Use AP-mode set_datetime command used by the app (cmd 0x17ee)")
    parser.add_argument("--sync-time-now", action="store_true", help="Set device time to the current Linux time using set_datetime")
    parser.add_argument("--set-time-epoch", type=int, default=None, help="Set device Unix time in seconds")
    parser.add_argument("--set-timezone", type=float, default=None, help="Set device timezone in hours, for example -5 or 5.5")
    parser.add_argument("--set-timezone-sec", type=int, default=None, help="Set device timezone offset in seconds")
    parser.add_argument("--set-ntp-switch", type=int, choices=[0, 1], default=None, help="Set device ntpSwitch")
    parser.add_argument("--set-ntp-server", default="", help="Set device ntpServer")
    parser.add_argument("--set-time-hour", type=int, default=None, help="Set device timeHour value used by the app")
    parser.add_argument("--set-dst-switch", type=int, default=None, help="Set device dstSwitch")
    parser.add_argument("--datetime-only", action="store_true", help="Send datetime commands and exit without opening live video")
    args = parser.parse_args()
    if args.quiet:
        args.verbose = False
    if args.quality:
        args.stream = QUALITY_TO_STREAM[args.quality]
    if args.low_power_mode is not None:
        args.set_param = [("low_power_mode", args.low_power_mode), *args.set_param]
    set_wifi_requested = bool(args.set_wifi_ssid or args.set_wifi_pwd or args.set_wifi_encryption is not None)
    if set_wifi_requested:
        if not args.set_wifi_ssid:
            parser.error("--set-wifi-ssid is required when using Wi-Fi provisioning")
        if args.set_wifi_encryption is None:
            parser.error("--set-wifi-encryption is required when using Wi-Fi provisioning")

    stop = False
    query_only = args.sd_status or args.sd_record_day is not None or bool(args.sd_record_list) or bool(args.delete_record_file) or args.scan_wifi
    apply_only = args.apply_only
    playback_only = bool(args.record_play_file or args.record_download_file)
    datetime_only = args.datetime_only or args.get_datetime or args.get_datetime_auto or args.get_parms_auto or args.get_record_param or args.sync_time_now or args.set_time_epoch is not None or args.set_timezone is not None or args.set_timezone_sec is not None or args.set_ntp_switch is not None or bool(args.set_ntp_server) or args.set_time_hour is not None or args.set_dst_switch is not None or query_only or apply_only or set_wifi_requested

    def handle_signal(signum, frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    sink = sys.stdout.buffer
    player_proc = None
    if not datetime_only or playback_only:
        sink, player_proc = open_sink(args)
    lib = load_ppcs()
    init = lib.PPCS_Initialize(SERVER)
    if init != 0:
        raise RuntimeError(f"PPCS_Initialize failed: {init}")

    handle = lib.PPCS_Connect(args.did.encode(), b"\x01", 0)
    if args.verbose:
        print(f"handle={handle}", file=sys.stderr)
    if handle < 0:
        last_error = handle
        for attempt in range(1, 6):
            if last_error != -8:
                break
            time.sleep(min(2 * attempt, 10))
            handle = lib.PPCS_Connect(args.did.encode(), b"\x01", 0)
            if args.verbose:
                print(f"handle_retry{attempt}={handle}", file=sys.stderr)
            if handle >= 0:
                break
            last_error = handle
        if handle < 0:
            raise RuntimeError(f"PPCS_Connect failed: {handle}")

    total_in = 0
    total_out = 0
    stripper = HomeEyeFrameStripper()
    deadline = time.time() + args.seconds if args.seconds > 0 else None
    waiting_for_keyframe = not args.no_wait_keyframe
    next_iframe_request = 0.0
    hevc_config = b""
    recovering_from_gap = False

    try:
        login = {
            "pro": "check_user",
            "cmd": 100,
            "user": args.user,
            "pwd": args.pwd,
            "video": args.stream,
            "name": "",
            "type": "",
        }
        if args.login_time_mode == "current":
            login["time"] = int(time.time())
        elif args.login_time_mode == "zero":
            login["time"] = 0
        if args.verbose:
            print(f"login_write={write_command(lib, handle, login)}", file=sys.stderr)
        else:
            write_command(lib, handle, login)

        if args.set_param:
            ret = send_set_params(lib, handle, args.user, args.pwd, args.set_param)
            if args.verbose:
                rendered = ",".join(f"{key}={value}" for key, value in args.set_param)
                print(f"set_params={rendered} write={ret}", file=sys.stderr)
            if args.set_param_delay > 0:
                time.sleep(args.set_param_delay)

        if args.night_vision_mode is not None:
            ret = send_dev_control(
                lib,
                handle,
                args.user,
                args.pwd,
                {"icut": args.night_vision_mode},
            )
            if args.verbose:
                print(f"night_vision_icut={args.night_vision_mode} write={ret}", file=sys.stderr)
            time.sleep(0.2)
            if args.night_vision_mode == 3:
                ret = send_dev_control(
                    lib,
                    handle,
                    args.user,
                    args.pwd,
                    {"ir_led_color_mode": 1},
                )
                if args.verbose:
                    print(f"night_vision_ir_led_color_mode=1 write={ret}", file=sys.stderr)
            elif args.night_vision_mode in (0, 1, 2):
                ret = send_dev_control(
                    lib,
                    handle,
                    args.user,
                    args.pwd,
                    {"ir_led_color_mode": 0},
                )
                if args.verbose:
                    print(f"night_vision_ir_led_color_mode=0 write={ret}", file=sys.stderr)
            if args.set_param_delay > 0:
                time.sleep(args.set_param_delay)

        if args.record_video is not None:
            ret = send_set_record_param(
                lib,
                handle,
                args.user,
                args.pwd,
                {"videoRecord": args.record_video},
            )
            if args.verbose:
                print(f"record_video={args.record_video} write={ret}", file=sys.stderr)
            if args.set_param_delay > 0:
                time.sleep(args.set_param_delay)

        if args.record_mode is not None:
            ret = send_set_timed_record_para(
                lib,
                handle,
                args.user,
                args.pwd,
                {
                    "programmeNub": 1,
                    "timedrecord_programme": RECORD_MODE_MAP[args.record_mode],
                    "tpModelArray": [],
                },
            )
            if args.verbose:
                print(f"record_mode={args.record_mode} write={ret}", file=sys.stderr)
            if args.set_param_delay > 0:
                time.sleep(args.set_param_delay)

        if args.wakeup_mode is not None:
            record_video = args.record_video if args.record_video is not None else 0
            ret = send_set_record_param(
                lib,
                handle,
                args.user,
                args.pwd,
                {"wakeup_mode": args.wakeup_mode, "videoRecord": record_video},
            )
            if args.verbose:
                print(
                    f"wakeup_mode={args.wakeup_mode},videoRecord={record_video} write={ret}",
                    file=sys.stderr,
                )
            if args.set_param_delay > 0:
                time.sleep(args.set_param_delay)

        record_param_updates = {}
        if args.record_sound is not None:
            record_param_updates["record_sound"] = args.record_sound
        if args.record_sound_during_wake_up_period is not None:
            record_param_updates["record_sound_during_wake_up_period"] = args.record_sound_during_wake_up_period
        if args.loop_coverage is not None:
            record_param_updates["loop_coverage"] = args.loop_coverage
        if args.sd_card_recording_duration is not None:
            record_param_updates["sd_card_recording_duration_minutes"] = args.sd_card_recording_duration
        if args.alarm_recording_duration is not None:
            record_param_updates["alarm_recording_duration_s"] = args.alarm_recording_duration
        if args.alarm_recording_interval is not None:
            record_param_updates["alarm_recording_interval_s"] = args.alarm_recording_interval
        if record_param_updates:
            ret = send_set_record_param(lib, handle, args.user, args.pwd, record_param_updates)
            if args.verbose:
                rendered = ",".join(f"{key}={value}" for key, value in record_param_updates.items())
                print(f"record_params={rendered} write={ret}", file=sys.stderr)
            if args.set_param_delay > 0:
                time.sleep(args.set_param_delay)

        timed_fields = {}
        if args.timed_record_start and args.timed_record_end:
            try:
                start_h, start_m = [int(part) for part in args.timed_record_start.split(":", 1)]
                end_h, end_m = [int(part) for part in args.timed_record_end.split(":", 1)]
            except ValueError as err:
                raise RuntimeError("timed recording start/end must be HH:MM") from err
            weekdays = []
            if args.timed_record_days:
                if re.fullmatch(r"[01]{7}", args.timed_record_days):
                    weekdays = [idx + 1 for idx, bit in enumerate(args.timed_record_days) if bit == "1"]
                else:
                    weekdays = [int(part) for part in args.timed_record_days.split(",") if part.strip()]
            if not weekdays:
                weekdays = [1, 2, 3, 4, 5, 6, 7]
            period_array = [
                {
                    "weekInt": day,
                    "day_timed_record_switch": args.timed_record_enable if args.timed_record_enable is not None else 1,
                    "startTimeInt": start_h * 100 + start_m,
                    "endTimeInt": end_h * 100 + end_m,
                }
                for day in weekdays
            ]
            timed_fields = {
                "programmeNub": 1,
                "timedrecord_programme": 0,
                "tpModelArray": [
                    {
                        "timedrecordRepeatSwitch": 1,
                        "RepeatPro_StartTimeInt": start_h * 100 + start_m,
                        "RepeatPro_EndTimeInt": end_h * 100 + end_m,
                        "periodArray": period_array,
                    }
                ],
            }
        if timed_fields:
            ret = send_set_timed_record_para(lib, handle, args.user, args.pwd, timed_fields)
            if args.verbose:
                print(f"timed_record_para write={ret}", file=sys.stderr)
            if args.set_param_delay > 0:
                time.sleep(args.set_param_delay)

        if args.get_datetime:
            ret = send_get_datetime(lib, handle, args.user, args.pwd, cmd=0x7D)
            if args.verbose:
                print(f"get_datetime_write={ret}", file=sys.stderr)
            reply = decode_datetime_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "get_datetime", "ok": True, **reply}, ensure_ascii=False))
            return

        if args.get_datetime_auto:
            ret = send_get_datetime(lib, handle, args.user, args.pwd, cmd=0x17ED)
            if args.verbose:
                print(f"get_datetime_auto_write={ret}", file=sys.stderr)
            reply = decode_datetime_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "get_datetime_auto", "ok": True, **reply}, ensure_ascii=False))
            return

        if args.get_parms_auto:
            ret = send_json_query(lib, handle, args.user, args.pwd, "get_parms", 0x17D5)
            if args.verbose:
                print(f"get_parms_auto_write={ret}", file=sys.stderr)
            reply = decode_sd_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "get_parms_auto", "ok": True, **reply}, ensure_ascii=False))
            return

        if args.get_record_param:
            ret = send_json_query(lib, handle, args.user, args.pwd, "get_record_param", 0xC7)
            if args.verbose:
                print(f"get_record_param_write={ret}", file=sys.stderr)
            reply = decode_sd_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "get_record_param", "ok": True, **reply}, ensure_ascii=False))
            return

        if args.get_timed_record_para:
            ret = send_json_query(lib, handle, args.user, args.pwd, "get_timed_record_para", 0x1D3)
            if args.verbose:
                print(f"get_timed_record_para_write={ret}", file=sys.stderr)
            reply = decode_sd_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "get_timed_record_para", "ok": True, **reply}, ensure_ascii=False))
            return

        datetime_fields = {}
        if args.sync_time_now:
            datetime_fields["time"] = int(time.time())
        if args.set_time_epoch is not None:
            datetime_fields["time"] = args.set_time_epoch
        if args.set_timezone is not None:
            datetime_fields["timeZone"] = args.set_timezone
        if args.set_timezone_sec is not None:
            datetime_fields["timeZone_Sec"] = args.set_timezone_sec
        elif args.set_timezone is not None:
            datetime_fields["timeZone_Sec"] = int(args.set_timezone * 3600)
        if args.set_ntp_switch is not None:
            datetime_fields["ntpSwitch"] = args.set_ntp_switch
        if args.set_ntp_server:
            datetime_fields["ntpServer"] = args.set_ntp_server
        if args.set_time_hour is not None:
            datetime_fields["timeHour"] = args.set_time_hour
        if args.set_dst_switch is not None:
            datetime_fields["dstSwitch"] = args.set_dst_switch
        if datetime_fields:
            datetime_cmd = 0x1406 if args.sync_time_now and len(datetime_fields) == 1 and not args.set_datetime_auto else 0x7E
            if args.set_datetime_auto:
                datetime_cmd = 0x17EE
            if datetime_cmd == 0x1406:
                datetime_fields = {"time": datetime_fields["time"]}
            ret = send_set_datetime(lib, handle, args.user, args.pwd, datetime_fields, cmd=datetime_cmd)
            if args.verbose:
                rendered = ",".join(f"{key}={value}" for key, value in datetime_fields.items())
                print(f"set_datetime={rendered} write={ret}", file=sys.stderr)
            time.sleep(0.5)

        if args.sd_status:
            ret = write_command(
                lib,
                handle,
                {
                    "pro": "get_sd",
                    "cmd": 0x6D,
                    "user": args.user,
                    "pwd": args.pwd,
                },
            )
            if args.verbose:
                print(f"sd_status_write={ret}", file=sys.stderr)
            reply = decode_sd_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "sd_status", "ok": True, **reply}, ensure_ascii=False))
            return

        if args.sd_record_day is not None:
            ret = write_command(
                lib,
                handle,
                {
                    "pro": "get_record_day",
                    "cmd": 0xCD,
                    "year": args.sd_record_day,
                    "user": args.user,
                    "pwd": args.pwd,
                    "index": 0,
                },
            )
            if args.verbose:
                print(f"sd_record_day_write={ret}", file=sys.stderr)
            reply = decode_sd_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "sd_record_day", "year": args.sd_record_day, "ok": True, **reply}, ensure_ascii=False))
            return

        if args.sd_record_list:
            record_list_date = normalize_record_list_date(args.sd_record_list)
            ret = write_command(
                lib,
                handle,
                {
                    "pro": "get_record_list",
                    "cmd": 0xCE,
                    "ymd": record_list_date,
                    "user": args.user,
                    "pwd": args.pwd,
                    "file_search": 1,
                    "index": 0,
                },
            )
            if args.verbose:
                print(f"sd_record_list_write={ret}", file=sys.stderr)
            reply = decode_sd_reply(read_control_reply(lib, handle))
            print(json.dumps({"kind": "sd_record_list", "ymd": args.sd_record_list, "camera_ymd": record_list_date, "ok": True, **reply}, ensure_ascii=False))
            return

        if args.delete_record_file:
            ret = write_command(
                lib,
                handle,
                {
                    "pro": "del_record_file",
                    "cmd": 0xD0,
                    "user": args.user,
                    "pwd": args.pwd,
                    "filename": args.delete_record_file,
                    "index": 0,
                },
            )
            if args.verbose:
                print(f"delete_record_write={ret}", file=sys.stderr)
            reply = decode_sd_reply(read_control_reply(lib, handle))
            response = reply.get("json", {})
            succeeded = isinstance(response, dict) and response.get("cmd") == 0xD0 and response.get("result") == 0
            print(json.dumps({"kind": "delete_record_file", "filename": args.delete_record_file, "ok": succeeded, **reply}, ensure_ascii=False))
            if not succeeded:
                raise RuntimeError(f"camera did not confirm deletion of {args.delete_record_file}")
            return

        if args.scan_wifi:
            ret = send_scan_wifi(lib, handle, args.user, args.pwd)
            if args.verbose:
                print(f"scan_wifi_write={ret}", file=sys.stderr)
            reply = decode_scan_wifi_reply(read_control_reply(lib, handle, timeout=4.0, min_idle=0.8))
            print(json.dumps({"kind": "scan_wifi", "ok": True, **reply}, ensure_ascii=False))
            return

        if set_wifi_requested:
            ret = send_set_wifi(
                lib,
                handle,
                args.user,
                args.pwd,
                args.set_wifi_ssid,
                args.set_wifi_pwd,
                args.set_wifi_encryption,
            )
            if args.verbose:
                print(
                    f"set_wifi=ssid:{args.set_wifi_ssid},encryption:{args.set_wifi_encryption} write={ret}",
                    file=sys.stderr,
                )
            reply = decode_sd_reply(read_control_reply(lib, handle, timeout=4.0, min_idle=0.8))
            print(
                json.dumps(
                    {
                        "kind": "set_wifi",
                        "ok": True,
                        "ssid": args.set_wifi_ssid,
                        "encryption": args.set_wifi_encryption,
                        **reply,
                    },
                    ensure_ascii=False,
                )
            )
            return

        if apply_only:
            return

        if datetime_only:
            return

        if args.record_download_file:
            download_stripper = HomeEyeDownloadStripper()
            ret = write_command(
                lib,
                handle,
                {
                    "pro": "download_file",
                    "cmd": 0x7B,
                    "user": args.user,
                    "pwd": args.pwd,
                    "type": 0,
                    "file_name": args.record_download_file,
                    "offset": args.record_play_offset,
                    "control": 1,
                    "index": 0,
                },
            )
            if args.verbose:
                print(f"record_download_write={ret}", file=sys.stderr)
            idle_reads = 0
            reported_total = False
            while not stop:
                read_size = args.read_chunk
                if args.check_buffer:
                    write_buffer = ctypes.c_int()
                    read_buffer = ctypes.c_int()
                    check_ret = lib.PPCS_Check_Buffer(
                        handle,
                        4,
                        ctypes.byref(write_buffer),
                        ctypes.byref(read_buffer),
                    )
                    if check_ret == 0 and read_buffer.value > 0:
                        read_size = min(max(args.read_chunk, read_buffer.value), args.max_read_chunk)
                buf = ctypes.create_string_buffer(read_size)
                size = ctypes.c_int(len(buf))
                ret = lib.PPCS_Read(handle, 4, buf, ctypes.byref(size), args.read_timeout)
                if (ret >= 0 or (ret == -3 and size.value > 0)) and size.value:
                    idle_reads = 0
                    chunk = bytes(buf.raw[: size.value])
                    total_in += len(chunk)
                    for payload in download_stripper.feed(chunk):
                        sink.write(payload)
                        total_out += len(payload)
                    if download_stripper.total_size and not reported_total:
                        print(f"download_total={download_stripper.total_size}", file=sys.stderr, flush=True)
                        reported_total = True
                    if args.verbose:
                        print(
                            f"download_bytes={total_out} total={download_stripper.total_size}",
                            file=sys.stderr,
                        )
                    remaining = max(0, download_stripper.total_size - args.record_play_offset)
                    if remaining and total_out >= remaining:
                        break
                else:
                    idle_reads += 1
                    if idle_reads >= 20 and total_out > 0:
                        remaining = max(0, download_stripper.total_size - args.record_play_offset)
                        if remaining and total_out < remaining:
                            raise RuntimeError(
                                f"native download stopped early: received {total_out} of {remaining} bytes"
                            )
                        break
            sink.flush()
            remaining = max(0, download_stripper.total_size - args.record_play_offset)
            if not download_stripper.total_size:
                raise RuntimeError("native download did not report a file size")
            if total_out != remaining:
                raise RuntimeError(
                    f"native download size mismatch: received {total_out} of {remaining} bytes"
                )
            with suppress(Exception):
                write_command(
                    lib,
                    handle,
                    {
                        "pro": "download_file",
                        "cmd": 0x7B,
                        "user": args.user,
                        "pwd": args.pwd,
                        "type": 0,
                        "file_name": args.record_download_file,
                        "offset": args.record_play_offset + total_out,
                        "control": 0,
                        "index": 0,
                    },
                )
            return

        if args.record_play_file:
            waiting_for_keyframe = False
            ret = write_command(
                lib,
                handle,
                {
                    "pro": "play_record_file",
                    "cmd": 0xCF,
                    "user": args.user,
                    "pwd": args.pwd,
                    "filename": args.record_play_file,
                    "offset": args.record_play_offset,
                    "index": 0,
                },
            )
            if args.verbose:
                print(f"record_play_write={ret}", file=sys.stderr)
            idle_reads = 0
            while not stop:
                read_size = args.read_chunk
                if args.check_buffer:
                    write_buffer = ctypes.c_int()
                    read_buffer = ctypes.c_int()
                    check_ret = lib.PPCS_Check_Buffer(
                        handle,
                        4,
                        ctypes.byref(write_buffer),
                        ctypes.byref(read_buffer),
                    )
                    if check_ret == 0 and read_buffer.value > 0:
                        read_size = min(max(args.read_chunk, read_buffer.value), args.max_read_chunk)
                buf = ctypes.create_string_buffer(read_size)
                size = ctypes.c_int(len(buf))
                ret = lib.PPCS_Read(handle, 4, buf, ctypes.byref(size), args.read_timeout)
                usable_partial = ret == -3 and size.value > 0 and buf.raw.startswith(FRAME_MAGIC)
                if (ret >= 0 or usable_partial) and size.value:
                    idle_reads = 0
                    chunk = bytes(buf.raw[: size.value])
                    total_in += len(chunk)
                    for frame in stripper.feed_frames(chunk):
                        hevc = frame["payload"]
                        config = extract_hevc_config(hevc)
                        if config:
                            hevc_config = config
                        if waiting_for_keyframe:
                            if not frame["keyframe"] and not has_clean_hevc_start(hevc):
                                continue
                            waiting_for_keyframe = False
                            if hevc_config and not hevc.startswith(hevc_config):
                                hevc = hevc_config + hevc
                        sink.write(hevc)
                        total_out += len(hevc)
                        if args.verbose:
                            print(f"playback_in={total_in} hevc={total_out}", file=sys.stderr)
                else:
                    idle_reads += 1
                    if idle_reads >= 20 and total_out > 0:
                        break
            tail = stripper.flush()
            if tail:
                sink.write(tail)
                total_out += len(tail)
            sink.flush()
            return

        stream = {
            "pro": "stream",
            "cmd": 111,
            "video": args.stream,
            "user": args.user,
            "pwd": args.pwd,
        }
        if args.verbose:
            print(f"stream_write={write_command(lib, handle, stream)}", file=sys.stderr)
        else:
            write_command(lib, handle, stream)

        if not args.no_iframe:
            try:
                iframe_ret = request_iframe(lib, handle, args.stream)
                if args.verbose:
                    print(f"iframe_write={iframe_ret}", file=sys.stderr)
            except Exception as exc:
                if args.verbose:
                    print(f"iframe_error={exc}", file=sys.stderr)
            next_iframe_request = time.time() + args.iframe_interval

        while not stop and (deadline is None or time.time() < deadline):
            if not args.no_iframe and args.iframe_interval > 0 and time.time() >= next_iframe_request:
                try:
                    request_iframe(lib, handle, args.stream)
                except Exception as exc:
                    if args.verbose:
                        print(f"iframe_error={exc}", file=sys.stderr)
                next_iframe_request = time.time() + args.iframe_interval

            read_size = args.read_chunk
            if args.check_buffer:
                write_buffer = ctypes.c_int()
                read_buffer = ctypes.c_int()
                check_ret = lib.PPCS_Check_Buffer(
                    handle,
                    1,
                    ctypes.byref(write_buffer),
                    ctypes.byref(read_buffer),
                )
                if check_ret == 0 and read_buffer.value > 0:
                    read_size = min(max(args.read_chunk, read_buffer.value), args.max_read_chunk)
                    if args.verbose and read_buffer.value > args.read_chunk:
                        print(f"ppcs_read_buffer={read_buffer.value}", file=sys.stderr)

            buf = ctypes.create_string_buffer(read_size)
            size = ctypes.c_int(len(buf))
            ret = lib.PPCS_Read(handle, 1, buf, ctypes.byref(size), args.read_timeout)
            usable_partial = ret == -3 and size.value > 0 and buf.raw.startswith(FRAME_MAGIC)
            if (ret >= 0 or usable_partial) and size.value:
                chunk = bytes(buf.raw[: size.value])
                total_in += len(chunk)
                frames = stripper.feed_frames(chunk)
                if stripper.gaps:
                    max_missing = 0
                    for prev_seq, seq in stripper.gaps:
                        missing = seq - prev_seq - 1
                        max_missing = max(max_missing, missing)
                        if args.verbose:
                            print(f"seq_gap={prev_seq}->{seq} missing={missing}", file=sys.stderr)
                    if (
                        max_missing >= args.gap_iframe_threshold
                        and not args.no_iframe
                        and not args.no_iframe_on_gap
                    ):
                        try:
                            iframe_ret = request_iframe(lib, handle, args.stream)
                            if args.verbose:
                                print(f"gap_iframe_write={iframe_ret}", file=sys.stderr)
                        except Exception as exc:
                            if args.verbose:
                                print(f"iframe_error={exc}", file=sys.stderr)
                        waiting_for_keyframe = not args.no_wait_keyframe
                        recovering_from_gap = True
                        next_iframe_request = time.time() + args.iframe_interval
                    stripper.gaps.clear()
                for frame in frames:
                    hevc = frame["payload"]
                    config = extract_hevc_config(hevc)
                    if config:
                        hevc_config = config
                    if waiting_for_keyframe:
                        if not frame["keyframe"] and not has_clean_hevc_start(hevc):
                            if args.verbose:
                                print(f"in={total_in} waiting_keyframe=1", file=sys.stderr)
                            continue
                        waiting_for_keyframe = False
                        if recovering_from_gap and hevc_config:
                            hevc = hevc_config + hevc
                            if args.verbose:
                                print("prepended_hevc_config=1", file=sys.stderr)
                        recovering_from_gap = False
                        if args.verbose:
                            print(f"in={total_in} keyframe_start=1", file=sys.stderr)
                    sink.write(hevc)
                    sink.flush()
                    total_out += len(hevc)
                    if args.verbose:
                        print(f"in={total_in} hevc={total_out}", file=sys.stderr)
            elif usable_partial and args.verbose:
                print(f"partial_frame_read=1 size={size.value}", file=sys.stderr)
            elif ret not in (-3, -4):
                if args.verbose:
                    print(f"read ret={ret} size={size.value}", file=sys.stderr)

        tail = stripper.flush()
        if tail:
            sink.write(tail)
            sink.flush()
            total_out += len(tail)
    finally:
        try:
            if sink is not sys.stdout.buffer:
                sink.close()
        except BrokenPipeError:
            pass
        if player_proc:
            player_proc.wait(timeout=2)
        if args.verbose:
            print(f"close={lib.PPCS_Close(handle)}", file=sys.stderr)
            print(f"deinit={lib.PPCS_DeInitialize()}", file=sys.stderr)
            print(f"saved_hevc={total_out}", file=sys.stderr)
        else:
            lib.PPCS_Close(handle)
            lib.PPCS_DeInitialize()


if __name__ == "__main__":
    main()
