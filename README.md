# CivicLINK – Sierra Leone
**ASK&KNOW BEFORE YOU GO** · ACOSAT Digital

## Features
- Self-service location + QR (logo in center)
- WhatsApp chat button on location pages
- Multi-country subscription (MRU + US + Canada)
- Monime payments (Orange Money m17, AfriMoney m18)
- Google Translate
- Full Terms & Privacy

## Local setup

```bash
npm install
psql -U postgres -d civiclink -f db/schema.sql
psql -U postgres -d civiclink -f db/migrate_subscription.sql
```

```powershell
$env:DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/civiclink"
$env:MONIME_TOKEN="your_monime_token"
$env:MONIME_SPACE_ID="spc-..."
$env:BASE_URL="http://localhost:3000"
node server.js
```

Without MONIME_TOKEN / MONIME_SPACE_ID, registration uses **test mode** (activates subscription immediately).

## Admin
- Email: admin@civiclink.sl
- Password: civiclink2026

## Pricing (configured in register.html)
Sierra Leone: NLe 50/year or NLe 5/month  
Other MRU + US/Canada rates as per ACOSAT schedule.
