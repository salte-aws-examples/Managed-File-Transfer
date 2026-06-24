export const ALLOW_ALL_CIDR = "0.0.0.0/0";

export function parseAllowedSourceCidrs(
  raw: string | undefined,
): string[] | null {
  if (!raw?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const cidrs = parsed.filter((entry): entry is string => typeof entry === "string");
    return cidrs.length > 0 ? cidrs : null;
  } catch {
    return null;
  }
}

export function allowsAllSourceIps(cidrs: string[]): boolean {
  return cidrs.some((cidr) => cidr.trim() === ALLOW_ALL_CIDR);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }

  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return null;
    }
    value = (value << 8) + octet;
  }

  return value >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } | null {
  const [ipPart, prefixPart] = cidr.split("/");
  if (!ipPart || prefixPart === undefined) {
    return null;
  }

  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }

  const ip = ipv4ToInt(ipPart);
  if (ip === null) {
    return null;
  }

  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return { network: ip & mask, mask };
}

export function sourceIpMatchesCidrs(sourceIp: string, cidrs: string[]): boolean {
  if (allowsAllSourceIps(cidrs)) {
    return true;
  }

  const ip = ipv4ToInt(sourceIp);
  if (ip === null) {
    return false;
  }

  return cidrs.some((cidr) => {
    if (cidr.trim() === ALLOW_ALL_CIDR) {
      return true;
    }
    const parsed = parseCidr(cidr);
    if (!parsed) {
      return false;
    }
    return (ip & parsed.mask) === parsed.network;
  });
}

export function resolveAllowedSourceCidrs(
  userCidrsRaw: string | undefined,
  partnerCidrsRaw: string | undefined,
  userOverridePresent: boolean,
): string[] | null {
  if (userOverridePresent) {
    const userCidrs = parseAllowedSourceCidrs(userCidrsRaw);
    if (userCidrs) {
      return userCidrs;
    }
  }
  return parseAllowedSourceCidrs(partnerCidrsRaw);
}
