// In-memory print queue per printer. Enough for the desk test and a single
// pilot till; swap for a database table before going live so jobs survive a
// restart.

import { randomUUID } from 'node:crypto';

export function createQueue() {
  const jobs = new Map(); // id -> job
  const order = []; // ids, oldest first

  return {
    enqueue(printerId, data) {
      const job = { id: randomUUID().replace(/-/g, '').slice(0, 20), printerId, state: 'queued', createdAt: Date.now(), ...data };
      jobs.set(job.id, job);
      order.push(job.id);
      return job;
    },
    // Oldest queued job for this printer, marked as sent so a second poll
    // doesn't print it twice.
    next(printerId) {
      const id = order.find((i) => jobs.get(i).printerId === printerId && jobs.get(i).state === 'queued');
      if (!id) return null;
      const job = jobs.get(id);
      job.state = 'sent';
      job.sentAt = Date.now();
      return job;
    },
    complete(jobId, ok, detail = '') {
      const job = jobs.get(jobId);
      if (!job) return null;
      job.state = ok ? 'printed' : 'failed';
      job.detail = detail;
      job.doneAt = Date.now();
      return job;
    },
    // Puts a failed or stuck job back in line (manual reprint).
    requeue(jobId) {
      const job = jobs.get(jobId);
      if (!job) return null;
      job.state = 'queued';
      return job;
    },
    get: (id) => jobs.get(id),
    list: () => order.map((i) => jobs.get(i)),
  };
}
