/**
 * server/files.ts — TASK 3: file storage abstraction.
 * Driver selected by env FILE_STORAGE:
 *   "local" (default) — blobs under FILE_DIR (default ./data/uploads)/<orgId>/<uuid>
 *   "s3"              — S3-compatible store via plain fetch + AWS Signature V4
 *                       (env S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET, S3_REGION).
 * No AWS SDK — SigV4 is ~60 lines of crypto and keeps the dependency tree flat.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FileDriver {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/* ----------------------------- local ------------------------------ */

const FILE_DIR = process.env.FILE_DIR ?? path.join(__dirname, "..", "data", "uploads");

/** storage keys are "<orgId>/<uuid>"; resolve safely under FILE_DIR. */
function localPath(key: string): string {
  const resolved = path.resolve(FILE_DIR, key);
  if (!resolved.startsWith(path.resolve(FILE_DIR) + path.sep)) {
    throw new Error("invalid storage key");
  }
  return resolved;
}

const localDriver: FileDriver = {
  async put(key, data) {
    const p = localPath(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, data);
  },
  async get(key) {
    return fs.promises.readFile(localPath(key));
  },
  async delete(key) {
    await fs.promises.rm(localPath(key), { force: true });
  },
};

/* ------------------------------ s3 -------------------------------- */

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}
function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secret: string;
  region: string;
}

function s3Config(): S3Config {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKey = process.env.S3_KEY;
  const secret = process.env.S3_SECRET;
  if (!endpoint || !bucket || !accessKey || !secret) {
    throw new Error("FILE_STORAGE=s3 requires S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET");
  }
  return { endpoint: endpoint.replace(/\/$/, ""), bucket, accessKey, secret, region: process.env.S3_REGION ?? "us-east-1" };
}

/** Minimal AWS SigV4 signer for path-style S3 requests. */
async function s3Request(method: "PUT" | "GET" | "DELETE", key: string, body?: Buffer, mime?: string): Promise<globalThis.Response> {
  const cfg = s3Config();
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (mime) headers["content-type"] = mime;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    url.pathname.split("/").map(encodeURIComponent).join("/"),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + cfg.secret, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const { host: _host, ...fetchHeaders } = headers; // fetch sets Host itself
  return fetch(url, {
    method,
    headers: { ...fetchHeaders, authorization },
    body: body ? new Uint8Array(body) : undefined,
  });
}

const s3Driver: FileDriver = {
  async put(key, data, mime) {
    const res = await s3Request("PUT", key, data, mime);
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status} ${await res.text()}`);
  },
  async get(key) {
    const res = await s3Request("GET", key);
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async delete(key) {
    const res = await s3Request("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed: ${res.status}`);
  },
};

/* ---------------------------- facade ------------------------------ */

export function fileDriver(): FileDriver {
  return (process.env.FILE_STORAGE ?? "local") === "s3" ? s3Driver : localDriver;
}

export function newStorageKey(orgId: number): string {
  return `${orgId}/${crypto.randomUUID()}`;
}
