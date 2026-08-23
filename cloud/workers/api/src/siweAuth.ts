const HEADER_SUFFIX = " wants you to sign in with your Ethereum account:";
const RFC_3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

export type ParsedSiweMessage = {
  address: string;
  chainId: number;
  domain: string;
  expirationTime?: string;
  issuedAt: string;
  nonce: string;
  notBefore?: string;
  statement: string;
  uri: string;
  version: "1";
};

function field(line: string, label: string): string {
  const prefix = `${label}: `;
  if (!line.startsWith(prefix)) {
    throw new Error("invalid-siwe-message");
  }
  const value = line.slice(prefix.length);
  if (!value) {
    throw new Error("invalid-siwe-message");
  }
  return value;
}

function validDate(value: string): boolean {
  const match = RFC_3339.exec(value);
  if (!match) {
    return false;
  }
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = Number(match[7] || 0);
  const offsetMinute = Number(match[8] || 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function parseDomain(value: string): string {
  if (!value || value !== value.trim()) {
    throw new Error("invalid-siwe-message");
  }
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("invalid-siwe-message");
  }
  if (
    !url.host ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid-siwe-message");
  }
  return url.host;
}

export function parseSiweMessage(message: string): ParsedSiweMessage {
  if (message.includes("\r")) {
    throw new Error("invalid-siwe-message");
  }
  const lines = message.split("\n");
  if (
    lines.length < 10 ||
    !lines[0].endsWith(HEADER_SUFFIX) ||
    lines[2] !== "" ||
    lines[4] !== ""
  ) {
    throw new Error("invalid-siwe-message");
  }
  const domain = parseDomain(lines[0].slice(0, -HEADER_SUFFIX.length));
  const address = lines[1];
  const statement = lines[3];
  const uri = field(lines[5], "URI");
  const version = field(lines[6], "Version");
  const chainId = Number(field(lines[7], "Chain ID"));
  const nonce = field(lines[8], "Nonce");
  const issuedAt = field(lines[9], "Issued At");
  if (
    !domain ||
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    version !== "1" ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !/^[A-Za-z0-9]{8,}$/.test(nonce) ||
    !validDate(issuedAt)
  ) {
    throw new Error("invalid-siwe-message");
  }
  try {
    new URL(uri);
  } catch {
    throw new Error("invalid-siwe-message");
  }
  let index = 10;
  let expirationTime: string | undefined;
  let notBefore: string | undefined;
  if (lines[index]?.startsWith("Expiration Time: ")) {
    expirationTime = field(lines[index++], "Expiration Time");
    if (!validDate(expirationTime)) {
      throw new Error("invalid-siwe-message");
    }
  }
  if (lines[index]?.startsWith("Not Before: ")) {
    notBefore = field(lines[index++], "Not Before");
    if (!validDate(notBefore)) {
      throw new Error("invalid-siwe-message");
    }
  }
  if (lines[index]?.startsWith("Request ID: ")) {
    const requestId = lines[index].slice("Request ID: ".length);
    if (
      !/^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9a-fA-F]{2})*$/.test(requestId)
    ) {
      throw new Error("invalid-siwe-message");
    }
    index++;
  }
  if (lines[index] === "Resources:") {
    index++;
    if (index === lines.length) {
      throw new Error("invalid-siwe-message");
    }
    for (; index < lines.length; index++) {
      if (!lines[index].startsWith("- ") || lines[index].length <= 2) {
        throw new Error("invalid-siwe-message");
      }
      try {
        new URL(lines[index].slice(2));
      } catch {
        throw new Error("invalid-siwe-message");
      }
    }
  }
  if (index !== lines.length) {
    throw new Error("invalid-siwe-message");
  }
  return {
    address,
    chainId,
    domain,
    ...(expirationTime ? { expirationTime } : {}),
    issuedAt,
    nonce,
    ...(notBefore ? { notBefore } : {}),
    statement,
    uri,
    version: "1",
  };
}
