# Zoho POS fiscal receipt printing (Option A)

The Zoho POS Retail Billing App (Windows and tablet) only prints its fixed
templates, which can't carry the MRA QR code or the "Not Yet Fiscalized" label.
This service prints the compliant receipt instead:

```
Retail Billing App sale
   -> Zoho POS workflow rule (on invoice / credit note created) -> webhook
   -> this service: normalize -> fiscalize via e-invoicing service -> build receipt
   -> cloud receipt printer at the till (Epson Server Direct Print)
```

App auto-print is switched off, so the customer gets a single receipt: ours.

## Run the desk test

```
npm install
npm test            # unit + HTTP tests
npm run desk-test   # sample payload -> webhook -> mock MRA -> simulated printer
```

`desk-test` runs the sample sale twice, once fiscalized and once with the
e-invoicing service down. It writes each receipt to `out/` as text, HTML and
Epson XML. Rendered samples: [fiscalized](docs/samples/SI-11-fiscalized.png),
[not yet fiscalized](docs/samples/SI-12-not-fiscalized.png).

## Layout

| File | Role |
|---|---|
| `src/zoho.js` | Decodes the Zoho POS webhook (nested JSON strings) and checks the totals add up |
| `src/fiscal.js` | E-invoicing client: `mock` for tests, `http` for the real service (TODO: map to its API) |
| `src/receipt.js` | Receipt content: seller, invoice, lines, VAT summary, QR/IRN or NYF label |
| `src/render/*` | Text preview, Epson ePOS-Print XML, HTML preview |
| `src/pipeline.js` | One sale -> one print job, once per Zoho ID |
| `src/queue.js` | Print queue per printer (in memory; needs a DB table before go-live) |
| `src/epsonSdp.js` | Epson Server Direct Print polling endpoint |
| `src/server.js` | HTTP endpoints |
| `src/config.js` | Seller details, secrets, location -> printer mapping |

## Endpoints

| Method | Path | |
|---|---|---|
| POST | `/webhooks/zoho-pos` | Zoho POS webhook. Needs header `x-fiscal-secret` |
| POST | `/epson/sdp` | Printer polling (set as the Server Direct Print URL on the printer) |
| GET | `/jobs` | Job states (secret header) |
| POST | `/jobs/:id/reprint` | Reprint (secret header) |
| GET | `/health` | |

## Environment

`PORT`, `ZOHO_WEBHOOK_SECRET`, `FISCAL_MODE` (`mock`/`http`), `FISCAL_BASE_URL`,
`FISCAL_API_KEY`, `FISCAL_TIMEOUT_MS`, `SELLER_NAME`, `SELLER_BRN`, `SELLER_VAT`,
`SELLER_ADDRESS`, `SELLER_PHONE`.

See [docs/zoho-pos-setup.md](docs/zoho-pos-setup.md) for the Zoho, printer
and open-question details.
