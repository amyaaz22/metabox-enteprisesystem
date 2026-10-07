// Runtime configuration. Everything client-specific lives here so the
// pipeline itself stays generic. Values marked TODO must come from the client.

export const config = {
  port: Number(process.env.PORT || 8080),

  // Shared secret Zoho POS sends in a custom webhook header.
  webhookSecret: process.env.ZOHO_WEBHOOK_SECRET || 'dev-secret',
  webhookSecretHeader: 'x-fiscal-secret',

  // 'mock' for the desk test; 'http' to call the real e-invoicing service.
  fiscalMode: process.env.FISCAL_MODE || 'mock',
  fiscalBaseUrl: process.env.FISCAL_BASE_URL || '',
  fiscalApiKey: process.env.FISCAL_API_KEY || '',
  fiscalTimeoutMs: Number(process.env.FISCAL_TIMEOUT_MS || 4000),

  // Seller block printed on every receipt. TODO: client details.
  seller: {
    name: process.env.SELLER_NAME || 'Valle Park (TEST)',
    brn: process.env.SELLER_BRN || 'C00000000',
    vatNumber: process.env.SELLER_VAT || '20000000',
    address: process.env.SELLER_ADDRESS || 'Address line, Mauritius',
    phone: process.env.SELLER_PHONE || '',
  },

  // Which printer serves a sale. The Zoho POS webhook carries no register or
  // device ID, so for now we route by the line items' location_id.
  // Key: Zoho location_id -> printer ID (the "ID" an Epson printer sends when
  // it polls Server Direct Print).
  printerByLocation: {
    '1496042000000095116': 'HEAD-OFFICE-TILL-1',
  },
  defaultPrinter: 'HEAD-OFFICE-TILL-1',
};
