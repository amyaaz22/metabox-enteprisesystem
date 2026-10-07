# Zoho POS and printer setup, and open questions

## What the sample webhook showed (invoice SI-11)

- The payload already carries **everything the receipt needs**: line items
  with qty, rate, discount, per-line VAT, sub_total, tax_total, total,
  invoice number, created time. **No extra API call to fetch the sale.**
- Nested fields (`line_items`, addresses, `custom_fields`) arrive as
  **JSON-encoded strings**; numbers arrive as strings. Handled in `src/zoho.js`.
- Prices are **tax-exclusive** in this org (571.00 + 85.65 = 656.65). Tax-inclusive
  is detected automatically.
- **No register / device / cashier ID** in the payload. Only `location_id`
  (from the line items). Printers are mapped per location for now, so this
  only works with **one printing till per location** until this is solved.
  Options: a custom field on the sale set per register, a separate location
  per till, or a cashier-to-printer mapping, if the cashier is available.
- **No payment details** (cash/card, tendered, change). Add them if MRA or the
  client needs them on the receipt.
- **No buyer BRN/VAT**. For B2B sales, add customer custom fields whose labels
  contain "BRN" and "VAT"; `src/zoho.js` picks them up.
- `invoice_url` contains a secure payment link token. It is never printed, and
  it is redacted in the test fixture. Stock fields were trimmed from the
  fixture as irrelevant.

## Zoho POS (web) setup

1. **Settings > Automation > Webhooks**: new webhook, module Invoices,
   method POST, URL `https://<host>/webhooks/zoho-pos`, body = the entity
   (default), custom header `x-fiscal-secret: <secret>`.
2. **Workflow rule**: module Invoices, when *Created*, action = that webhook.
3. Repeat for **Credit Notes** (refunds/returns) with the same URL.
4. **Retail Billing App**: turn off automatic receipt printing on every
   device so only the fiscal receipt prints.

## Printer setup (Epson TM-m30III / TM-T88VII)

1. Connect to the shop LAN/Wi-Fi. Open the printer's web config.
2. **Server Direct Print**: enable, URL `https://<host>/epson/sdp`,
   interval 1–3 s, ID = the printer ID used in `src/config.js`
   (e.g. `HEAD-OFFICE-TILL-1`).
3. No port forwarding needed: the printer calls out to the service.

Star CloudPRNT is not implemented yet. Add it if the client's printers are Star.

## Open questions

- [ ] E-invoicing API spec: request/response, auth, sandbox URL. Replace the
      assumed contract in `src/fiscal.js` `httpClient`.
- [ ] Retry of Not Yet Fiscalized sales: does the e-invoicing service queue
      and retry by itself, or must this service retry
      (`pipeline.pendingFiscalization()`)?
- [ ] MRA receipt core elements: confirm the layout in `src/receipt.js`
      against the MRA spec and a receipt from the current POS.
- [ ] Register/till ID (see above).
- [ ] Measure webhook delay on a real Zoho POS org: time from "Complete sale"
      to webhook arrival. This decides whether Option A is fast enough at the counter.
- [ ] Persistent queue (DB) and hosting choice before the pilot.
