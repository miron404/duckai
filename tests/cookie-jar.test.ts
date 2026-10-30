import { describe, it, expect } from "bun:test";
import { CookieJar } from "../src/cookie-jar";

function headersWith(cookies: string[]): Headers {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

describe("CookieJar", () => {
  it("starts empty and produces no header", () => {
    const jar = new CookieJar();
    expect(jar.size).toBe(0);
    expect(jar.header()).toBeUndefined();
  });

  it("seeds from a raw Cookie header value", () => {
    const jar = new CookieJar();
    jar.seed("atb=abc; ah=EU-ru; broken");
    expect(jar.names()).toEqual(["atb", "ah"]);
    expect(jar.header()).toBe("atb=abc; ah=EU-ru");
  });

  it("absorbs every Set-Cookie of a response", () => {
    const jar = new CookieJar();
    jar.absorb(headersWith(["a=1; Path=/; HttpOnly", "b=2; Expires=Wed, 01 Jan 2030 00:00:00 GMT"]));
    expect(jar.header()).toBe("a=1; b=2");
  });

  it("keeps Expires commas from splitting a cookie", () => {
    const jar = new CookieJar();
    jar.absorb(
      headersWith([
        "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
        "b=2; Path=/",
      ]),
    );
    expect(jar.header()).toBe("a=1; b=2");
  });

  it("treats an expired cookie as a deletion", () => {
    const jar = new CookieJar();
    jar.seed("keep=1; drop=2");
    jar.absorb(headersWith(["drop=; Max-Age=0; Path=/"]));
    expect(jar.names()).toEqual(["keep"]);
  });

  it("lets a response override a seeded cookie", () => {
    const jar = new CookieJar();
    jar.seed("atb=old");
    jar.absorb(headersWith(["atb=new; Path=/"]));
    expect(jar.header()).toBe("atb=new");
  });

  it("returns the latest value for a repeated cookie", () => {
    const jar = new CookieJar();
    jar.absorb(headersWith(["x=1"]));
    jar.absorb(headersWith(["x=2"]));
    expect(jar.size).toBe(1);
    expect(jar.header()).toBe("x=2");
  });
});
