# Donation Receipt Simulation Endpoint

This repository now exposes an authenticated HTTPS Cloud Function, `simulateDonationReceipt`, that can be used to trigger a Stripe PaymentIntent and send a Stripe email receipt to any test recipient.

## Prerequisites

1. Deploy the updated Cloud Functions.
2. Configure the following environment variables for the deployed functions:
   - `STRIPE_SECRET_KEY` – existing live/test key with email receipts enabled.
   - `SIMULATION_SECRET` – a shared secret you choose for securing the endpoint.
3. Ensure Stripe email receipts are enabled in the Stripe Dashboard.

You can set `SIMULATION_SECRET` for Firebase Functions by using an `.env` file or via:

```bash
firebase functions:config:set simulation.secret="<your-secret>"
```

When using `.env`, add the line `SIMULATION_SECRET=<your-secret>` under the `functions/` directory before deploying.

## Example curl Request

Replace `<PROJECT_ID>` with your Firebase project id and `<YOUR_SECRET>` with the value configured above.

```bash
curl -X POST \
  "https://us-central1-<PROJECT_ID>.cloudfunctions.net/simulateDonationReceipt" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: <YOUR_SECRET>" \
  -d '{"email":"saulsetton16@gmail.com","amount":18,"name":"Saul Setton","phone":"3475551212"}'
```

The endpoint responds with the PaymentIntent id and status once Stripe confirms the simulated charge. Because the request uses Stripe's built-in test card (`pm_card_visa`), the charge succeeds immediately and Stripe sends its standard receipt email to the provided address.

## Notes

- The request body is optional; defaults are provided for every field, but supplying a real name and phone number helps with bookkeeping.
- Each simulated intent is tagged with `entryType: 'donation-simulation'` and `simulation: true` in Firestore so you can distinguish tests from real donations.
- Do **not** expose the endpoint publicly without changing or rotating `SIMULATION_SECRET`; anyone with the secret can trigger a charge.
