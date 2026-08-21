import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

const toKey = (keyHex: string): Buffer => {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("FACTOREE_SECRET_KEY must be 32 bytes of hexadecimal");
  }
  return Buffer.from(keyHex, "hex");
};

export const encryptSecret = (plaintext: string, keyHex: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", toKey(keyHex), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
};

export const decryptSecret = (value: string, keyHex: string): string => {
  const [version, ivPart, tagPart, bodyPart] = value.split(".");
  if (version !== VERSION || !ivPart || !tagPart || !bodyPart) {
    throw new Error("unsupported cipher text format");
  }
  const decipher = createDecipheriv("aes-256-gcm", toKey(keyHex), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyPart, "base64")), decipher.final()]).toString("utf8");
};
