const path = require('path');
const dotenv = require('dotenv');
const Stripe = require('stripe');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET_LIVE;
const webhookUrl = process.env.STRIPE_WEBHOOK_URL || 'https://us-central1-yderaffle.cloudfunctions.net/stripeWebhook';

if (!stripeSecretKey) {
  console.error('Missing STRIPE_SECRET_KEY/STRIPE_SECRET in functions/.env');
  process.exit(1);
}

if (!webhookSecret) {
  console.error('Missing STRIPE_WEBHOOK_SECRET in functions/.env');
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey);

async function replayPaymentIntent(paymentIntentId, index) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (pi.status !== 'succeeded') {
    console.warn(`Skipping ${paymentIntentId}: status is ${pi.status}, expected succeeded.`);
    return { paymentIntentId, skipped: true, reason: `status=${pi.status}` };
  }

  const event = {
    id: `evt_backfill_${Date.now()}_${index}`,
    object: 'event',
    api_version: pi.api_version || '2020-08-27',
    created: Math.floor(Date.now() / 1000),
    data: { object: pi },
    livemode: !!pi.livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: 'payment_intent.succeeded'
  };

  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
    timestamp: Math.floor(Date.now() / 1000)
  });

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signature
    },
    body: payload
  });

  const body = await response.text();
  return {
    paymentIntentId,
    status: response.status,
    ok: response.ok,
    responseBody: body
  };
}

async function main() {
  const ids = process.argv.slice(2).filter(Boolean);

  if (!ids.length) {
    console.error('Usage: node scripts/replayPaymentIntentWebhook.js <pi_id_1> <pi_id_2> ...');
    process.exit(1);
  }

  console.log(`Replaying ${ids.length} payment_intent.succeeded event(s) to ${webhookUrl}`);

  const results = [];
  for (let i = 0; i < ids.length; i += 1) {
    const paymentIntentId = ids[i];
    try {
      const result = await replayPaymentIntent(paymentIntentId, i);
      results.push(result);
      if (result.skipped) {
        console.log(`- ${paymentIntentId}: SKIPPED (${result.reason})`);
      } else {
        console.log(`- ${paymentIntentId}: HTTP ${result.status} | ${result.responseBody}`);
      }
    } catch (error) {
      results.push({ paymentIntentId, error: error.message });
      console.error(`- ${paymentIntentId}: ERROR ${error.message}`);
    }
  }

  const failed = results.filter((r) => r.error || (r.ok === false));
  if (failed.length) {
    console.error('\nSome replays failed:');
    failed.forEach((item) => console.error(item));
    process.exit(1);
  }

  console.log('\nAll replay requests completed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
