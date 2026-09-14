import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function encryptionKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error('缺少 TOKEN_ENCRYPTION_KEY');
  if (secret.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY 至少需要 32 个字符');
  return createHash('sha256').update(secret).digest();
}

export function encryptToken(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptToken(value) {
  const [version, ivText, tagText, encryptedText] = String(value).split('.');
  if (version !== 'v1') throw new Error('不支持的 Token 加密格式');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
