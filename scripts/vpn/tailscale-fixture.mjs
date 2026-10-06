const peer = (id, country, ip) => ({ ID: id, DNSName: id + '.mullvad.ts.net.', Location: { CountryCode: country }, TailscaleIPs: [ip], ExitNodeOption: true, Online: true, ExitNode: false });
export const initial = () => ({ BackendState: 'Running', TUN: false, Peer: { us: peer('us-node', 'US', '100.64.0.1'), de: peer('de-node', 'DE', '100.64.0.2') }, ExitNodeStatus: null });

// Substitute only operating-system executable boundaries. The production bridge
// runs in another process with real HTTP, execFile, signals and state files.
export const executable = `
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.VPN_FIXTURE_DIRECTORY;
const file = path.join(directory, 'fixture.json');
const fixture = JSON.parse(fs.readFileSync(file));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(directory, 'requests.jsonl'), JSON.stringify({ command, args }) + '\\n');
if (command === 'curl') {
  process.stdout.write(JSON.stringify(fixture.probe ?? { mullvad_exit_ip: true, ip: '8.8.8.8' }));
} else if (args[1] === 'status') {
  process.stdout.write(fixture.malformed ? 'private daemon output: never return this' : JSON.stringify(fixture.status));
} else if (args[1] === 'set') {
  fs.writeFileSync(path.join(directory, 'mutation.pid'), String(process.pid));
  if (fixture.hold) setInterval(() => {}, 1000);
  else {
    const ip = args[2].slice('--exit-node='.length);
    const selected = Object.values(fixture.status.Peer).find(peer => peer.TailscaleIPs.includes(ip));
    for (const peer of Object.values(fixture.status.Peer)) peer.ExitNode = peer === selected;
    fixture.status.ExitNodeStatus = selected ? { ID: selected.ID, Online: true } : null;
    fs.writeFileSync(file, JSON.stringify(fixture));
  }
} else throw Error('Unexpected command');
`;
