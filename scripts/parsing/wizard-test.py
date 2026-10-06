import json
import os
import pty
import select
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
child = subprocess.Popen(
    [sys.argv[1], sys.argv[2], "--headless", "--parse-mode", "async"],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
)
os.close(slave)
output = bytearray()
rendered = bytearray()
submitted = False
entered = False
cancelled = False
deadline = time.monotonic() + 25
try:
    while child.poll() is None:
        if time.monotonic() >= deadline:
            raise RuntimeError("Interactive parsing did not settle: " + output.decode(errors="replace"))
        readable = select.select([master, sys.stdin], [], [], 0.1)[0]
        if master in readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            output.extend(chunk)
            sys.stderr.write(chunk.decode(errors="replace"))
            sys.stderr.flush()
            if submitted and not entered:
                rendered.extend(chunk)
                query_at = rendered.find(b"JFK to LAX interrupted interactive")
                if query_at >= 0 and rendered.rfind(b"\x1b[?2026l") > query_at:
                    os.write(master, b"\r")
                    entered = True
        if not submitted and b"Where are you flying?" in output:
            flags = termios.tcgetattr(master)[3]
            if not flags & (termios.ICANON | termios.ECHO):
                os.write(master, b"JFK to LAX interrupted interactive")
                submitted = True
        if sys.stdin in readable and sys.stdin.readline().strip() == "cancel" and not cancelled:
            os.write(master, b"\x03")
            cancelled = True
    child.wait(timeout=5)
    if not entered or not cancelled:
        raise RuntimeError("Interactive fixture missed input or cancellation")
    print(json.dumps({"code": child.returncode, "output": output.decode(errors="replace")}))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    os.close(master)
