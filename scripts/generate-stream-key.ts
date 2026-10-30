#!/usr/bin/env bun
/**
 * Prints a `STREAM_KEY` value without touching a browser.
 *
 * duck.ai's `durableStream` uses an RSA-OAEP-256 key pair that the web client
 * generates locally (WebCrypto `generateKey({name:"RSA-OAEP", modulusLength:
 * 2048|3072})`) and keeps in `localStorage` under
 * `duckaiStreamsTestCredentials`. Nothing is issued by the server, so any
 * valid RSA-OAEP key works:
 *
 *   bun run stream-key
 *   STREAM_KEY='{"publicKey":{"kty":"RSA",...}}' bun run probe
 *
 * Only the public half is printed - the private key is not needed by the
 * server, since the stream is encrypted *to* this key.
 */
import { generateKeyPairSync } from "node:crypto";

const MODULUS_BITS = 2048;

const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: MODULUS_BITS,
  publicExponent: 0x10001,
});

const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
const publicJwk = {
  ...jwk,
  alg: "RSA-OAEP-256",
  use: "enc",
  ext: true,
};

// The server only ever needs the public key, and this key is disposable, so
// printing it to stdout is fine.
console.log(JSON.stringify({ publicKey: publicJwk }));
