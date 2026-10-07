// Epson Server Direct Print. The printer polls this endpoint with a form POST:
//   ConnectionType=GetRequest  -> we answer with the next job (or nothing)
//   ConnectionType=SetResponse -> the printer reports whether the job printed
// The printer's "ID" (set in its web config) is the printer ID in config.js.

const wrapJob = (job) => `<?xml version="1.0" encoding="utf-8"?>
<PrintRequestInfo Version="2.00">
<ePOSPrint>
<Parameter>
<devid>local_printer</devid>
<timeout>10000</timeout>
<printjobid>${job.id}</printjobid>
</Parameter>
<PrintData>
${job.epos}
</PrintData>
</ePOSPrint>
</PrintRequestInfo>`;

export function handleSdp(form, queue, log = () => {}) {
  const printerId = form.get('ID') || '';
  const type = form.get('ConnectionType');

  if (type === 'GetRequest') {
    const job = queue.next(printerId);
    if (!job) return { status: 200, type: 'text/xml; charset=utf-8', body: '' };
    log(`sdp: sent job ${job.id} (${job.number}) to ${printerId}`);
    return { status: 200, type: 'text/xml; charset=utf-8', body: wrapJob(job) };
  }

  if (type === 'SetResponse') {
    const xml = form.get('ResponseFile') || '';
    for (const block of xml.split('</ePOSPrint>')) {
      const jobId = /<printjobid>([^<]*)<\/printjobid>/.exec(block)?.[1];
      if (!jobId) continue;
      const ok = /<response[^>]*success="true"/.test(block);
      const code = /<response[^>]*code="([^"]*)"/.exec(block)?.[1] || '';
      queue.complete(jobId, ok, code);
      log(`sdp: job ${jobId} ${ok ? 'printed' : `failed (${code})`} on ${printerId}`);
    }
    return { status: 200, type: 'text/plain', body: '' };
  }

  return { status: 400, type: 'text/plain', body: 'Unknown ConnectionType' };
}
