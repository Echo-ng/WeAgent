import { app } from 'electron';
import { join } from 'node:path';

/** 开发态：apps/desktop/resources；安装包：resources/resources */
export function getResourcePath(...segments: string[]): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', ...segments);
  }
  return join(__dirname, '../../resources', ...segments);
}
