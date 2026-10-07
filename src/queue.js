// Print queue per printer, kept in the store so it works across serverless
// instances:
//   jobs/<id>.json                  the job (ePOS XML, state, timings)
//   queue/<printer>/<time>-<id>     marker: job waiting for that printer
// A printer polls one request at a time, so taking the oldest marker and
// deleting it is enough to hand each job out once.

import { randomUUID } from 'node:crypto';
import { readJson } from './store.js';

export function createQueue(store) {
  const jobKey = (id) => `jobs/${id}.json`;
  const marker = (job) => `queue/${job.printerId}/${String(Date.now()).padStart(15, '0')}-${job.id}`;
  const save = (job) => store.write(jobKey(job.id), JSON.stringify(job));

  return {
    async enqueue(printerId, data) {
      const job = { id: randomUUID().replace(/-/g, '').slice(0, 20), printerId, state: 'queued', createdAt: Date.now(), ...data };
      await save(job);
      await store.write(marker(job), job.id);
      return job;
    },
    async next(printerId) {
      const [first] = await store.list(`queue/${printerId}/`);
      if (!first) return null;
      await store.remove(first);
      const job = await readJson(store, jobKey(first.split('-').pop()));
      if (!job) return null;
      job.state = 'sent';
      job.sentAt = Date.now();
      await save(job);
      return job;
    },
    async complete(jobId, ok, detail = '') {
      const job = await readJson(store, jobKey(jobId));
      if (!job) return null;
      Object.assign(job, { state: ok ? 'printed' : 'failed', detail, doneAt: Date.now() });
      await save(job);
      return job;
    },
    // Puts a job back in line (manual reprint).
    async requeue(jobId) {
      const job = await readJson(store, jobKey(jobId));
      if (!job) return null;
      job.state = 'queued';
      await save(job);
      await store.write(marker(job), job.id);
      return job;
    },
    get: (id) => readJson(store, jobKey(id)),
    async list() {
      const keys = await store.list('jobs/');
      const jobs = await Promise.all(keys.map((k) => readJson(store, k)));
      return jobs.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
    },
  };
}
