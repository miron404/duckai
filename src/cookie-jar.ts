/**
 * Minimal cookie jar for duck.ai.
 *
 * duck.ai's anti-abuse layer sees a full browser session -- including the
 * cookies the frontend picks up on the landing page -- while a bare HTTP client
 * otherwise arrives without any. Keeping the cookies that `GET /` and
 * `GET /status` hand out (and sending them back on the chat request) is the
 * cheapest way to look like a continuing session instead of a cold hit.
 *
 * This is deliberately not an RFC 6265 implementation: duck.ai's cookies are
 * plain `name=value` pairs for the `duck.ai` origin, so names are enough. Every
 * cookie is scoped to the whole jar for the same reason.
 */
export class CookieJar {
  private readonly values = new Map<string, string>();

  /** Number of cookies currently held. */
  get size(): number {
    return this.values.size;
  }

  /**
   * Seeds the jar from a raw `Cookie:` header value, e.g. the one copied out of
   * a browser ("a=1; b=2"). Already known cookies keep their value only when
   * the seeded one is empty.
   */
  seed(raw: string | undefined | null): void {
    if (!raw) return;
    for (const part of raw.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 1) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name) this.values.set(name, value);
    }
  }

  /** Absorbs every `Set-Cookie` header of a response. */
  absorb(headers: Headers): void {
    for (const header of readSetCookie(headers)) {
      const [pair] = header.split(";");
      const separator = pair.indexOf("=");
      if (separator < 1) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;

      // An expired cookie is a deletion.
      const dropped = /max-age\s*=\s*(0|-\d+)/i.test(header) ||
        /expires\s*=\s*thu,?\s*01\s*jan\s*1970/i.test(header);
      if (dropped) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  /** The `Cookie:` header value, or `undefined` when the jar is empty. */
  header(): string | undefined {
    if (this.values.size === 0) return undefined;
    return [...this.values.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  /** Cookie names only, for diagnostics (never log the values). */
  names(): string[] {
    return [...this.values.keys()];
  }
}

/**
 * `Set-Cookie` is special: `Headers.get()` joins several cookies with ", ",
 * which is ambiguous because `Expires` contains a comma too. Prefer the
 * dedicated accessors when the runtime has them.
 */
function readSetCookie(headers: Headers): string[] {
  const withAccessors = headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };

  if (typeof withAccessors.getSetCookie === "function") {
    return withAccessors.getSetCookie();
  }
  if (typeof withAccessors.getAll === "function") {
    return withAccessors.getAll("set-cookie");
  }

  const joined = headers.get("set-cookie");
  if (!joined) return [];
  // Split before `name=` that follows a comma, but keep `Expires=<date>` intact.
  return joined.split(/,(?=\s*[^;,=]+=)/g).map((part) => part.trim());
}
