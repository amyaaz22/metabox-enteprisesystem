// Local HTTP server. Uses Vercel Blob if BLOB_READ_WRITE_TOKEN is set,
// otherwise keeps everything in memory.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createFiscalClient } from './fiscal.js';
import { createBlobStore, createMemoryStore } from './store.js';
import { createHandler } from './app.js';

export function createServer({ cfg = config, fiscal = createFiscalClient(), store = createMemoryStore(), log = console.log } = {}) {
  const { handler, pipeline, queue } = createHandler({ cfg, fiscal, store, log });
  return { server: http.createServer(handler), pipeline, queue, store };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = process.env.BLOB_READ_WRITE_TOKEN ? createBlobStore() : createMemoryStore();
  const { server } = createServer({ store });
  server.listen(config.port, () => console.log(`fiscal print service on :${config.port} (fiscal mode: ${config.fiscalMode})`));
}
