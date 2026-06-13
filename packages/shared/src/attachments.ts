export const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 4;

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export interface MessageImageAttachment {
  id: string;
  kind: 'image';
  fileName: string;
  mimeType: string;
  path: string;
  previewDataUrl?: string;
}

export interface SendMessageOptions {
  attachments?: SavedImageAttachment[];
}

export interface SaveImageAttachmentInput {
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface SavedImageAttachment extends MessageImageAttachment {}

/** 常见不支持视觉的多模态占位模型（第三方路由） */
const NON_VISION_MODEL_PATTERNS = [
  /deepseek/i,
  /qwen/i,
  /llama/i,
  /mistral/i,
  /glm/i,
  /^gpt-/i,
  /^o1-/i,
  /^o3-/i,
];

export function modelSupportsVision(model?: string): boolean {
  if (!model?.trim()) return true;
  return !NON_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}
