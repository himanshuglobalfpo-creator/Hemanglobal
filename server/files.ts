// ============================================================================
// FILE STORAGE — driver abstraction for attachments
// ============================================================================
// The driver is a dumb byte store: the attachment route encrypts payloads with
// AES-256-GCM (crypto-vault encryptBlob) BEFORE calling put(), and decrypts
// after get(), so every blob is encrypted at rest whether it lands on local
// disk or in S3 — the driver never sees plaintext file bytes in production.
//
// FILE_STORAGE=local (default): blobs under FILE_DIR (default ./data/uploads)
//   at <orgId>/<uuid> — org prefix keeps tenant blobs physically separated.
// FILE_STORAGE=s3: S3-compatible store via plain fetch + AWS Signature V4
//   (no SDK). Env: S3_ENDPOINT (e.g. https://s3.us-east-1.amazonaws.com or a
//   MinIO/R2 endpoint), S3_BUCKET, S3_KEY, S3_SECRET, optional S3_REGION
//   (default us-east-1).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FileDriver {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------
class LocalDriver implements FileDriver {
  private root: string;
  constructor() {
    this.root = process.env.FILE_DIR || path.join(process.cwd(), "data", "uploads");
  }
  private resolve(key: string): string {
    // key is "<orgId>/<uuid>" — both components are server-generated, but
    // normalize + verify anyway so a corrupted key can never traverse out.
    const p = path.normalize(path.join(this.root, key));
    if (!p.startsWith(path.normalize(this.root))) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.resolve(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, data);
  }
  async get(key: string): Promise<Buffer> {
    return fs.promises.readFile(this.resolve(key));
  }
  async delete(key: string): Promise<void> {
    await fs.promises.unlink(this.resolve(key)).catch((e) => {
      if (e.code !== "ENOENT") throw e; // deleting a missing blob is fine
    });
  }
}

// ---------------------------------------------------------------------------
// S3 driver — AWS Signature V4 with plain fetch, no SDK.
// ---------------------------------------------------------------------------
function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

class S3Driver implements FileDriver {
  private endpoint: string;
  private bucket: string;
  private key: string;
  private secret: string;
  private region: string;

  constructor() {
    const { S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET } = process.env;
    if (!S3_ENDPOINT || !S3_BUCKET || !S3_KEY || !S3_SECRET) {
      throw new Error("FILE_STORAGE=s3 requires S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET");
    }
    this.endpoint = S3_ENDPOINT.replace(/\/$/, "");
    this.bucket = S3_BUCKET;
    this.key = S3_KEY;
    this.secret = S3_SECRET;
    this.region = process.env.S3_REGION || "us-east-1";
  }

  // Signs and sends one request (SigV4, path-style addressing for maximum
  // compatibility with MinIO/R2/localstack).
  private async request(method: "PUT" | "GET" | "DELETE", objectKey: string, body?: Buffer, contentType?: string): Promise<Response> {
    const url = new URL(`${this.endpoint}/${this.bucket}/${objectKey}`);
    const host = url.host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (contentType) headers["content-type"] = contentType;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalUri = url.pathname.split("/").map(encodeURIComponent).join("/");
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac("AWS4" + this.secret, dateStamp), this.region), "s3"), "aws4_request");
    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

    const auth = `AWS4-HMAC-SHA256 Credential=${this.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await fetch(url.toString(), {
      method,
      headers: { ...headers, Authorization: auth },
      body: body as any,
    });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 ${method} ${objectKey} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.request("PUT", key, data, contentType);
  }
  async get(key: string): Promise<Buffer> {
    const res = await this.request("GET", key);
    return Buffer.from(await res.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    await this.request("DELETE", key);
  }
}

let driver: FileDriver | null = null;
export function fileDriver(): FileDriver {
  if (!driver) {
    driver = process.env.FILE_STORAGE === "s3" ? new S3Driver() : new LocalDriver();
  }
  return driver;
}

// Attachment policy: whitelist + 10MB, enforced at the route.
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MIME_WHITELIST: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};
