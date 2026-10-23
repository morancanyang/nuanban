import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication, type ServerApplication, type ServerStorageOptions } from './http.ts';
import { createStandaloneGuidanceService } from './standalone-guidance.ts';

export interface StartServerOptions {
  host?: string;
  port?: number;
  storage?: ServerStorageOptions;
  webOrigins?: readonly string[];
}

function configuredWebOrigins(): string[] {
  return (process.env.NUANBAN_WEB_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

function configuredStorage(): ServerStorageOptions {
  if (process.env.NUANBAN_SERVER_STORAGE === 'sqlite') {
    return {
      kind: 'sqlite',
      path: process.env.NUANBAN_SERVER_DB_PATH,
      environment: process.env.NUANBAN_SERVER_ENV ?? process.env.NODE_ENV ?? 'development',
    };
  }
  return { kind: 'memory' };
}

export function startServer(options: StartServerOptions = {}): ServerApplication {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  const application = createApplication({
    storage: options.storage ?? configuredStorage(),
    standaloneGuidance: createStandaloneGuidanceService(),
    webOrigins: options.webOrigins ?? configuredWebOrigins(),
  });
  application.server.listen(port, host, () => {
    const address = application.server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    process.stdout.write(`nuanban-server listening on http://${host}:${boundPort}\n`);
  });
  return application;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) startServer();
