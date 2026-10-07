// Vercel function: every path is rewritten here (see vercel.json).

import { createHandler } from '../src/app.js';
import { createFiscalClient } from '../src/fiscal.js';
import { createBlobStore } from '../src/store.js';
import { config } from '../src/config.js';

// Never run in the cloud with the development secrets from config.js.
if (config.webhookSecret === 'dev-secret' || config.adminKey === 'dev-admin') {
  throw new Error('Set ZOHO_WEBHOOK_SECRET and ADMIN_KEY');
}

const { handler } = createHandler({ fiscal: createFiscalClient(), store: createBlobStore() });

export default handler;
