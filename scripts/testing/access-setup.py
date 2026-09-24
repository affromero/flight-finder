"""Exercise local access setup through a real terminal in integration tests."""

import errno
import os
import pty
import select
import subprocess
import sys
import time


def main():
    name = os.environ['TEST_ACCESS_NAME']
    password = os.environ['TEST_ACCESS_PASSWORD']
    if not sys.argv[1:] or any(char in name + password for char in '\r\n'):
        raise ValueError('A command and single-line setup inputs are required')
    prompts = [
        (b'First Admin profile name: ', name.encode() + b'\n'),
        (b'Shared password: ', password.encode() + b'\n'),
        (b'Confirm shared password: ', password.encode() + b'\n'),
    ]
    master, slave = pty.openpty()
    process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    deadline = time.monotonic() + 90
    seen = bytearray()
    index = 0
    try:
        while True:
            if time.monotonic() >= deadline:
                raise RuntimeError('Local access setup timed out')
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 4096)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b''
                if chunk:
                    seen.extend(chunk)
                    if index < len(prompts) and prompts[index][0] in seen:
                        os.write(master, prompts[index][1])
                        seen.clear()
                        index += 1
                elif process.poll() is not None:
                    break
            if process.poll() is not None:
                break
        if process.wait(timeout=5) != 0 or index != len(prompts):
            raise RuntimeError('Local access setup failed before completing all prompts')
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        os.close(master)


if __name__ == '__main__':
    main()
