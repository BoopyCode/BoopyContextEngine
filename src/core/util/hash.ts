import { createHash } from 'node:crypto';

export function sha1(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

export function hashContent(value: string): string {
  return sha1(value);
}

export function shortHash(value: string): string {
  return sha1(value).slice(0, 12);
}
