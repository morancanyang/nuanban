import type { ConversationPort } from '@nuanban/application';
import { RemoteConversation, type RemoteApiClient } from '@nuanban/api-client';
import type { PlatformMode } from '@nuanban/config';
import { DesktopConversation } from './text-question';

export function createConversation(platformMode: PlatformMode, remoteClient: RemoteApiClient | null): ConversationPort {
  if (remoteClient && platformMode !== 'windows') return new RemoteConversation(remoteClient);
  return new DesktopConversation();
}
