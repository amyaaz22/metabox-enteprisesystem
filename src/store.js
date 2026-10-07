// Small key/value storage used for sales, print jobs and the printer queues.
// Memory for tests and local runs; Vercel Blob (private store) when deployed,
// because serverless instances don't share memory between requests.

import { put, get, list, del } from '@vercel/blob';

export function createMemoryStore() {
  const data = new Map();
  return {
    // Writes only if the key is new; returns false if it already existed.
    async create(key, value) {
      if (data.has(key)) return false;
      data.set(key, value);
      return true;
    },
    async write(key, value) { data.set(key, value); },
    async read(key) { return data.has(key) ? data.get(key) : null; },
    async list(prefix) { return [...data.keys()].filter((k) => k.startsWith(prefix)).sort(); },
    async remove(key) { data.delete(key); },
  };
}

export function createBlobStore({ token = process.env.BLOB_READ_WRITE_TOKEN } = {}) {
  const opts = { access: 'private', token, addRandomSuffix: false, contentType: 'text/plain; charset=utf-8' };
  return {
    async create(key, value) {
      try {
        await put(key, value, { ...opts, allowOverwrite: false });
        return true;
      } catch (err) {
        if (/already exists/i.test(err.message)) return false;
        throw err;
      }
    },
    async write(key, value) { await put(key, value, { ...opts, allowOverwrite: true }); },
    async read(key) {
      const res = await get(key, { access: 'private', token, useCache: false });
      if (!res || !res.stream) return null;
      return new Response(res.stream).text();
    },
    async list(prefix) {
      const keys = [];
      let cursor;
      do {
        const page = await list({ prefix, cursor, token, limit: 1000 });
        keys.push(...page.blobs.map((b) => b.pathname));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return keys.sort();
    },
    async remove(key) { await del(key, { token }); },
  };
}

export const readJson = async (store, key) => {
  const raw = await store.read(key);
  return raw == null ? null : JSON.parse(raw);
};
