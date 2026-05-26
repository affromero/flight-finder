import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const INSTALL_SH = readFileSync(
  resolve(__dirname, '../../../public/install.sh'),
  'utf-8'
);
const CLI_SH = readFileSync(
  resolve(__dirname, '../../../public/flight-finder-cli'),
  'utf-8'
);

describe('install.sh', () => {
  it('uses bash shebang, not sh', () => {
    expect(INSTALL_SH).toMatch(/^#!\/usr\/bin\/env bash/);
  });

  it('documents | bash in usage comment, not | sh', () => {
    const usageLine = INSTALL_SH.split('\n').find((l) =>
      l.includes('Usage:')
    );
    expect(usageLine).toContain('| bash');
    expect(usageLine).not.toMatch(/\| sh\b/);
  });

  it('does not reference | sh in user-facing messages', () => {
    // Find all lines that show the install command to users (printf/echo with curl)
    const userFacingLines = INSTALL_SH.split('\n').filter(
      (l) => l.includes('flight-finder.org/install.sh') && !l.startsWith('#')
    );
    for (const line of userFacingLines) {
      expect(line, `Line references | sh: ${line.trim()}`).not.toMatch(
        /\| sh\b/
      );
    }
  });

  it('auto-adds ~/.local/bin to shell profile when not in PATH', () => {
    // Should modify a shell profile, not just print a warning
    expect(INSTALL_SH).toContain('>> "$file"');
  });

  it('patches both .bashrc and .profile for SSH login shells', () => {
    expect(INSTALL_SH).toContain('.bashrc');
    expect(INSTALL_SH).toContain('.profile');
    expect(INSTALL_SH).toContain('.bash_profile');
  });

  it('exports PATH for the rest of the script after adding it', () => {
    expect(INSTALL_SH).toContain('export PATH="$INSTALL_BIN:$PATH"');
  });

  it('guards xdg-open behind DISPLAY/WAYLAND_DISPLAY check', () => {
    const xdgLines = INSTALL_SH.split('\n').filter((l) =>
      l.includes('xdg-open')
    );
    expect(xdgLines.length).toBeGreaterThan(0);
    for (const line of xdgLines) {
      // The guard should be on the same line or the line before (elif)
      const lineIdx = INSTALL_SH.split('\n').indexOf(line);
      const context = INSTALL_SH.split('\n')
        .slice(Math.max(0, lineIdx - 1), lineIdx + 1)
        .join('\n');
      expect(
        context,
        `xdg-open not guarded: ${line.trim()}`
      ).toMatch(/DISPLAY|WAYLAND_DISPLAY/);
    }
  });

  it('gates macOS open command behind uname Darwin check', () => {
    const lines = INSTALL_SH.split('\n');
    const openLines = lines.filter(
      (l) =>
        /\bopen\s+"http/.test(l) &&
        !l.includes('xdg-open') &&
        !l.trimStart().startsWith('#')
    );
    expect(openLines.length).toBeGreaterThan(0);
    for (const line of openLines) {
      const idx = lines.indexOf(line);
      const context = lines
        .slice(Math.max(0, idx - 1), idx + 1)
        .join('\n');
      expect(
        context,
        `open not gated behind Darwin: ${line.trim()}`
      ).toContain('Darwin');
    }
  });

  it('redirects both stdout and stderr for xdg-open', () => {
    const xdgExecLines = INSTALL_SH.split('\n').filter(
      (l) => l.includes('xdg-open') && !l.includes('command -v')
    );
    for (const line of xdgExecLines) {
      expect(line, `xdg-open stderr not redirected: ${line.trim()}`).toMatch(
        />[^ ]* 2>&1/
      );
    }
  });

  it('includes cli-cache volume for persisting CLI installs', () => {
    expect(INSTALL_SH).toContain('cli-cache:/home/node/.npm-global');
  });

  it('detects Podman as fallback when Docker is absent', () => {
    expect(INSTALL_SH).toContain('command -v podman');
    expect(INSTALL_SH).toContain('CONTAINER_CMD=podman');
  });

  it('uses $CONTAINER_CMD to select compose command', () => {
    expect(INSTALL_SH).toContain('podman compose');
    expect(INSTALL_SH).toContain('podman-compose');
  });

  it('uses host.containers.internal for Podman Ollama host', () => {
    expect(INSTALL_SH).toContain('host.containers.internal:11434');
  });

  it('conditionally omits extra_hosts for Podman in generated compose', () => {
    expect(INSTALL_SH).toContain('EXTRA_HOSTS_BLOCK');
    expect(INSTALL_SH).toContain('CONTAINER_CMD" != "podman"');
  });

  it('detection logic: picks docker when docker exists, podman as fallback', () => {
    // Extract the detection block and verify the branching structure
    const lines = INSTALL_SH.split('\n');
    const dockerCheckIdx = lines.findIndex((l) => l.includes('command -v docker'));
    const podmanCheckIdx = lines.findIndex((l) => l.includes('command -v podman'));
    expect(dockerCheckIdx).toBeGreaterThan(-1);
    expect(podmanCheckIdx).toBeGreaterThan(-1);
    // Docker must be checked BEFORE podman (if/elif structure)
    expect(dockerCheckIdx).toBeLessThan(podmanCheckIdx);
    // The docker check must set CONTAINER_CMD=docker
    const dockerSetIdx = lines.findIndex((l) => l.includes('CONTAINER_CMD=docker'));
    expect(dockerSetIdx).toBeGreaterThan(dockerCheckIdx);
    expect(dockerSetIdx).toBeLessThan(podmanCheckIdx);
  });

  it('EXTRA_HOSTS_BLOCK is set before the heredoc and used inside it', () => {
    const lines = INSTALL_SH.split('\n');
    const blockSetIdx = lines.findIndex((l) => l.includes('EXTRA_HOSTS_BLOCK='));
    const heredocIdx = lines.findIndex((l) => l.includes('<< COMPOSE'));
    const blockUseIdx = lines.findIndex((l) => l.includes('$EXTRA_HOSTS_BLOCK'));
    expect(blockSetIdx).toBeGreaterThan(-1);
    expect(heredocIdx).toBeGreaterThan(-1);
    expect(blockUseIdx).toBeGreaterThan(-1);
    // Set before heredoc, used inside heredoc
    expect(blockSetIdx).toBeLessThan(heredocIdx);
    expect(blockUseIdx).toBeGreaterThan(heredocIdx);
  });

  it('Podman path sets OLLAMA_HOST to host.containers.internal, Docker to host.docker.internal', () => {
    const lines = INSTALL_SH.split('\n');
    const podmanOllamaIdx = lines.findIndex((l) =>
      l.includes('host.containers.internal:11434')
    );
    const dockerOllamaIdx = lines.findIndex((l) =>
      l.includes('host.docker.internal:11434')
    );
    expect(podmanOllamaIdx).toBeGreaterThan(-1);
    expect(dockerOllamaIdx).toBeGreaterThan(-1);
    // Both must be inside a CONTAINER_CMD conditional
    const beforePodman = lines.slice(Math.max(0, podmanOllamaIdx - 3), podmanOllamaIdx).join('\n');
    expect(beforePodman).toContain('podman');
    const beforeDocker = lines.slice(Math.max(0, dockerOllamaIdx - 3), dockerOllamaIdx).join('\n');
    expect(beforeDocker).toContain('else');
  });

  describe('Docker reachability detection (regression: #62)', () => {
    // The previous version always interpreted `docker info` failure as
    // "daemon down" and told the user to run `systemctl start docker`. On
    // Manjaro/Arch the more common failure is permission denied (user not
    // in docker group, or shell session hasn't picked up the group).
    //
    // Tests below operate on INSTALL_SH_CODE — the script with shell
    // comments stripped — so a string-presence assertion can't pass just
    // because the same word appears in a comment near the change.
    const INSTALL_SH_CODE = INSTALL_SH.split('\n')
      .map((l) => {
        // Drop full-line comments (allowing leading whitespace) but keep
        // shebang, and don't strip mid-line "#" since shell strings can
        // contain them. Conservative line-level filter is enough here.
        const trimmed = l.trimStart();
        if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) return '';
        return l;
      })
      .join('\n');

    it('gates on docker info exit status, not stderr presence', () => {
      // docker info can exit 0 while emitting stderr warnings (deprecated
      // config, plugin notices). Gating on `[ -n "$err" ]` would falsely
      // trigger the failure branch in that case; gating on `if !
      // var=$(...)` reads the actual exit status.
      expect(INSTALL_SH_CODE).toMatch(/if\s+!\s+docker_info_err=\$\(docker info\s+2>&1\s+1>\/dev\/null\)/);
      // The pre-fix pattern that ignored exit status must not reappear.
      expect(INSTALL_SH_CODE).not.toMatch(/docker info\s+&>\/dev\/null\s+2>&1.*\n[^#]*case.*docker_info_err/s);
    });

    it('matches "permission denied" branch separately from daemon-down', () => {
      // Both case variants because docker error output has differed by
      // version (lowercase older, capital P newer).
      expect(INSTALL_SH_CODE).toContain('"permission denied"');
      expect(INSTALL_SH_CODE).toContain('"Permission denied"');
    });

    it('permission-denied branch tells the user about the docker group and newgrp', () => {
      // Locate the permission case body via the literal case pattern, not
      // generic substring. That way a future comment containing
      // "permission denied" can't satisfy the test on its own.
      const codeAfterPermPattern = INSTALL_SH_CODE.split('"permission denied"')[1] ?? '';
      // Body should reach the matching `;;` of the permission case. Use a
      // generous slice — we only need to confirm the user-facing message.
      const caseBody = codeAfterPermPattern.split(';;')[0] ?? '';
      expect(caseBody).toContain('docker');
      expect(caseBody).toContain('group');
      expect(caseBody).toContain('newgrp');
      // And the suggestion to refresh group membership must include
      // usermod, which is the canonical fix for users not yet in the group.
      expect(caseBody).toContain('usermod');
    });

    it('daemon-down branch still suggests systemctl start docker', () => {
      // Existing behavior must still work for the "daemon really is not
      // running" case — verify the systemctl message survives the refactor.
      expect(INSTALL_SH_CODE).toContain('sudo systemctl start docker');
    });

    it('"Could not start Docker" only fires after permission-denied is excluded', () => {
      // Regression guard: the old code unconditionally said "Could not
      // start Docker" on any docker info failure. The new branching must
      // place that fail() AFTER the permission-denied case body.
      const codeLines = INSTALL_SH_CODE.split('\n');
      const couldNotStartIdx = codeLines.findIndex((l) =>
        l.includes('Could not start Docker')
      );
      const permissionDeniedIdx = codeLines.findIndex((l) =>
        l.includes('"permission denied"')
      );
      expect(permissionDeniedIdx).toBeGreaterThan(-1);
      expect(couldNotStartIdx).toBeGreaterThan(permissionDeniedIdx);
    });
  });
});

describe('flight-finder-cli', () => {
  it('uses bash shebang', () => {
    expect(CLI_SH).toMatch(/^#!\/usr\/bin\/env bash/);
  });

  it('guards xdg-open behind DISPLAY/WAYLAND_DISPLAY check', () => {
    const xdgLines = CLI_SH.split('\n').filter((l) =>
      l.includes('xdg-open')
    );
    expect(xdgLines.length).toBeGreaterThan(0);
    for (const line of xdgLines) {
      const lineIdx = CLI_SH.split('\n').indexOf(line);
      const context = CLI_SH.split('\n')
        .slice(Math.max(0, lineIdx - 1), lineIdx + 1)
        .join('\n');
      expect(
        context,
        `xdg-open not guarded: ${line.trim()}`
      ).toMatch(/DISPLAY|WAYLAND_DISPLAY/);
    }
  });

  it('gates macOS open command behind uname Darwin check', () => {
    const lines = CLI_SH.split('\n');
    const openLines = lines.filter(
      (l) =>
        /\bopen\s+"http/.test(l) &&
        !l.includes('xdg-open') &&
        !l.trimStart().startsWith('#')
    );
    expect(openLines.length).toBeGreaterThan(0);
    for (const line of openLines) {
      const idx = lines.indexOf(line);
      const context = lines
        .slice(Math.max(0, idx - 1), idx + 1)
        .join('\n');
      expect(
        context,
        `open not gated behind Darwin: ${line.trim()}`
      ).toContain('Darwin');
    }
  });

  it('does not reference | sh for install command', () => {
    const installLines = CLI_SH.split('\n').filter(
      (l) => l.includes('flight-finder.org/install.sh') && !l.startsWith('#')
    );
    for (const line of installLines) {
      expect(line, `Line references | sh: ${line.trim()}`).not.toMatch(
        /\| sh\b/
      );
    }
  });

  it('detects Podman as fallback when Docker is absent', () => {
    expect(CLI_SH).toContain('command -v podman');
    expect(CLI_SH).toContain('CONTAINER_CMD=podman');
  });

  it('uses $CONTAINER_CMD to select compose command', () => {
    expect(CLI_SH).toContain('podman compose');
    expect(CLI_SH).toContain('podman-compose');
  });

  it('skips docker info check when using Podman', () => {
    // Both start functions must gate docker info behind CONTAINER_CMD=docker check
    const dockerInfoChecks = CLI_SH.split('\n').filter(
      (l) => l.includes('docker info') && !l.startsWith('#')
    );
    for (const line of dockerInfoChecks) {
      const idx = CLI_SH.split('\n').indexOf(line);
      const context = CLI_SH.split('\n')
        .slice(Math.max(0, idx - 1), idx + 1)
        .join('\n');
      expect(context, `docker info not gated: ${line.trim()}`).toContain(
        'CONTAINER_CMD'
      );
    }
  });

  it('never `exec`s the dc() shell function (regression: GH #64)', () => {
    // `exec` only runs external commands; `exec dc ...` invokes /usr/bin/dc
    // (the desk calculator), producing errors like `dc: invalid option -- 't'`.
    // To replace the process with docker compose, expand $_DC inline instead.
    const offending = CLI_SH.split('\n').filter(
      (l) => /^\s*exec\s+dc(\s|$)/.test(l) && !l.trimStart().startsWith('#')
    );
    expect(
      offending,
      `'exec dc ...' must use $_DC directly:\n${offending.join('\n')}`
    ).toEqual([]);
  });
});
