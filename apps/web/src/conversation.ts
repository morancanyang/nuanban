import type { ConversationPort } from '@nuanban/application';
import { RemoteConversation, type RemoteApiClient } from '@nuanban/api-client';
import type { PlatformMode } from '@nuanban/config';
import { AndroidModelConversation, androidModelBridge } from './android-model';
import { DesktopConversation } from './text-question';

export function createConversation(platformMode: PlatformMode, remoteClient: RemoteApiClient | null): ConversationPort {
  // Android 宿主注入受限原生桥时优先使用；未注入则保持原有桌面/远程路径（不伪装成桌面 IPC）。
  const androidBridge = androidModelBridge();
  if (androidBridge) return new AndroidModelConversation(androidBridge);
  if (remoteClient && platformMode !== 'windows') return new RemoteConversation(remoteClient);
  return new DesktopConversation();
}
