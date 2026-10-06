interface Peer {
  ID: string;
  DNSName: string;
  Location: { CountryCode: string };
  TailscaleIPs: string[];
  ExitNodeOption: boolean;
  Online: boolean;
  ExitNode: boolean;
}
export function initial(): { BackendState: string; TUN: boolean; Peer: Record<string, Peer>; ExitNodeStatus: null };
export const executable: string;
