import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  type SaveImageAttachmentInput,
  type SavedImageAttachment,
} from '@weagent/shared';

function extFromMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export class AttachmentStore {
  constructor(private rootDir: string) {}

  saveImage(
    conversationId: string,
    input: SaveImageAttachmentInput,
    workspaceDir?: string,
  ): SavedImageAttachment {
    if (!SUPPORTED_IMAGE_MIME_TYPES.includes(input.mimeType as (typeof SUPPORTED_IMAGE_MIME_TYPES)[number])) {
      throw new Error(`不支持的图片格式：${input.mimeType}`);
    }

    const buf = Buffer.from(input.base64, 'base64');
    if (!buf.length) throw new Error('图片数据为空');
    if (buf.length > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new Error(`图片不能超过 ${Math.round(MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024)}MB`);
    }

    const dir = workspaceDir?.trim()
      ? join(workspaceDir, '.weagent', 'attachments', conversationId)
      : join(this.rootDir, 'attachments', conversationId);
    mkdirSync(dir, { recursive: true });

    const id = randomUUID();
    const ext = extname(input.fileName).replace('.', '') || extFromMime(input.mimeType);
    const path = join(dir, `${id}.${ext}`);
    writeFileSync(path, buf);

    return {
      id,
      kind: 'image',
      fileName: input.fileName,
      mimeType: input.mimeType,
      path,
      previewDataUrl: `data:${input.mimeType};base64,${input.base64}`,
    };
  }

  readImageAsDataUrl(filePath: string): string {
    const normalized = resolve(filePath);
    const markerA = `${sep}.weagent${sep}attachments${sep}`;
    const markerB = `${sep}attachments${sep}`;
    if (!normalized.includes(markerA) && !normalized.includes(markerB)) {
      throw new Error('无效的图片路径');
    }

    const buf = readFileSync(normalized);
    if (!buf.length) throw new Error('图片文件为空');

    const ext = extname(normalized).replace('.', '').toLowerCase();
    const mimeType =
      ext === 'png'
        ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : 'application/octet-stream';

    return `data:${mimeType};base64,${buf.toString('base64')}`;
  }
}
