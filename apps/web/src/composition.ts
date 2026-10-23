import { configuration } from '@nuanban/config';
import { IndexedDbRepository, IndexedDbDrawing, IndexedDbDrawingJobs } from '@nuanban/local-data';
import { RemoteApiClient, RemoteRepository, RemoteViews } from '@nuanban/api-client';
import { createPlatform } from '@nuanban/platform-ports';
import type { AppServices } from '@nuanban/application';
import { DesktopImageQuestion } from './image-question';
import { createConversation } from './conversation';
import { emptyLocalSnapshot } from './local-snapshot';

const environment = { ...import.meta.env };
export const config = configuration(environment, import.meta.env.VITE_DEPLOYMENT === 'production');
const remoteBaseUrl = environment.VITE_API_BASE_URL;
if (config.apiMode === 'real' && !remoteBaseUrl) throw new Error('远程业务服务模式必须配置 VITE_API_BASE_URL。');
export const remoteClient = config.apiMode === 'real' ? new RemoteApiClient({ baseUrl: remoteBaseUrl!, authorization: () => environment.VITE_API_TOKEN }) : null;
export const remoteViews = remoteClient ? new RemoteViews(remoteClient) : null;
export const services: AppServices = {
  ownerId: config.apiMode === 'local' ? 'local-owner' : (environment.VITE_API_OWNER_ID ?? 'remote-owner'),
  repository: remoteClient ? new RemoteRepository(remoteClient) : new IndexedDbRepository(),
  conversation: createConversation(config.platformMode, remoteClient),
};
export const platform = createPlatform();
export const imageQuestionService = new DesktopImageQuestion();
export const drawingService = new IndexedDbDrawing(services.ownerId);
export const drawingJobService = new IndexedDbDrawingJobs(services.ownerId);
export const initialSnapshot = emptyLocalSnapshot;
