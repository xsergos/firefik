export type SourceScope = "" | "private" | "public";

interface ParsedIP {
  bits: 32 | 128;
  value: bigint;
}

interface ParsedCidr extends ParsedIP {
  prefix: number;
}

function parseIPv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function hexGroups(part: string): bigint[] | null {
  if (!part) return [];
  const out: bigint[] = [];
  for (const g of part.split(":")) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(BigInt(`0x${g}`));
  }
  return out;
}

function parseIPv6(s: string): bigint | null {
  let text = s;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = hexGroups(halves[0] ?? "");
  const rest = hexGroups(halves[1] ?? "");
  if (!head || !rest) return null;
  const known = head.length + rest.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const groups = [...head, ...Array<bigint>(8 - known).fill(0n), ...rest];
  return groups.reduce((acc, g) => (acc << 16n) | g, 0n);
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;

export function parseIP(raw: string): ParsedIP | null {
  const s = raw.trim();
  if (!s) return null;
  if (!s.includes(":")) {
    const v4 = parseIPv4(s);
    return v4 === null ? null : { bits: 32, value: v4 };
  }
  const v6 = parseIPv6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === V4_MAPPED_PREFIX >> 32n) return { bits: 32, value: v6 & 0xffffffffn };
  return { bits: 128, value: v6 };
}

export function parseCidr(raw: string): ParsedCidr | null {
  const [addr, len, extra] = raw.trim().split("/");
  if (addr === undefined || len === undefined || extra !== undefined || !/^\d{1,3}$/.test(len))
    return null;
  const ip = parseIP(addr);
  if (!ip) return null;
  const prefix = Number(len);
  if (prefix > ip.bits) return null;
  return { ...ip, prefix };
}

function contains(net: ParsedCidr, ip: ParsedIP): boolean {
  if (net.bits !== ip.bits) return false;
  const shift = BigInt(net.bits - net.prefix);
  return net.value >> shift === ip.value >> shift;
}

const PRIVATE_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "fc00::/7",
  "fe80::/10",
  "::1/128",
].map((c) => parseCidr(c) as ParsedCidr);

export const PRIVATE_RANGE_LABEL =
  "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, loopback, link-local, fc00::/7";

export function isPrivateIP(raw: string): boolean {
  const ip = parseIP(raw);
  return !!ip && PRIVATE_RANGES.some((net) => contains(net, ip));
}

export function isCidrFilter(src: string): boolean {
  return src.includes("/");
}

export function isValidSourceFilter(src: string): boolean {
  return !isCidrFilter(src) || parseCidr(src) !== null;
}

export function sourceMatches(srcIP: string, src: string, scope: SourceScope): boolean {
  if (src) {
    if (isCidrFilter(src)) {
      const net = parseCidr(src);
      const ip = parseIP(srcIP);
      if (!net || !ip || !contains(net, ip)) return false;
    } else if (!srcIP.startsWith(src)) {
      return false;
    }
  }
  if (scope === "private") return isPrivateIP(srcIP);
  if (scope === "public") return !!parseIP(srcIP) && !isPrivateIP(srcIP);
  return true;
}
