const admin = require('firebase-admin');
const path = require('path');

/**
 * This script records a handful of manual Split the Pot and Rolex raffle sales
 * directly into Firestore. It expects a Firebase service account key named
 * `serviceAccountKey.json` to be present in the same directory.
 *
 * Usage: node manual_sales_entry.js
 */

// Resolve the service account file relative to the script so it works no matter
// where the script is executed from within the repository.
const serviceAccountPath = path.resolve(__dirname, 'serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/**
 * Generates a referrer RefID using the "FirstName + LastInitial" convention
 * that the rest of the project relies on.
 *
 * @param {string} fullName
 * @returns {string | null}
 */
function generateRefId(fullName) {
  if (!fullName) return null;
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts[parts.length - 1] : 'A';
  return `${firstName}${lastName.charAt(0).toUpperCase()}`;
}

/**
 * Fetch all referrers once so we can look them up by refId or by name.
 * @returns {Promise<Map<string, { uid: string, name: string, refId: string }>>}
 */
async function loadReferrers() {
  const snapshot = await db.collection('referrers').get();
  const map = new Map();

  snapshot.forEach(doc => {
    const data = doc.data();
    if (!data) return;
    const refId = data.refId;
    const normalizedName = (data.name || '').trim().toLowerCase();

    if (refId) {
      map.set(refId, { uid: doc.id, name: data.name || null, refId });
    }

    if (normalizedName) {
      map.set(normalizedName, { uid: doc.id, name: data.name || null, refId: refId || null });
    }
  });

  return map;
}

/**
 * Attempt to resolve the referrer metadata for a given name.
 * @param {Map<string, { uid: string, name: string, refId: string }>} lookup
 * @param {string | undefined} referrerName
 * @returns {{ referrerUid: string | null, referrerRefId: string | null, referrerName: string | null }}
 */
function resolveReferrer(lookup, referrerName) {
  if (!referrerName) {
    return { referrerUid: null, referrerRefId: null, referrerName: null };
  }

  const generatedRefId = generateRefId(referrerName);
  const normalizedName = referrerName.trim().toLowerCase();

  let referrerEntry = null;
  if (generatedRefId && lookup.has(generatedRefId)) {
    referrerEntry = lookup.get(generatedRefId);
  } else if (lookup.has(normalizedName)) {
    referrerEntry = lookup.get(normalizedName);
  }

  if (!referrerEntry) {
    console.warn(`⚠️  Unable to locate referrer "${referrerName}" in Firestore.`);
    return { referrerUid: null, referrerRefId: null, referrerName: null };
  }

  return {
    referrerUid: referrerEntry.uid,
    referrerRefId: referrerEntry.refId,
    referrerName: referrerEntry.name
  };
}

const entries = [
  {
    type: 'split-pot',
    name: 'Mark Abadi',
    phoneNumber: null,
    ticketCount: 5,
    amountPaid: 50,
    paymentMethod: 'Manual - Paid',
    notes: '5 Split the Pot tickets for $50.'
  },
  {
    type: 'split-pot',
    name: 'Victor Cohen',
    phoneNumber: null,
    ticketCount: 5,
    amountPaid: 52,
    paymentMethod: 'Manual - Paid',
    notes: '5 Split the Pot tickets for $52.'
  },
  {
    type: 'split-pot',
    name: 'Charlie Hara',
    phoneNumber: '(718) 790-2080',
    ticketCount: 5,
    amountPaid: 50,
    paymentMethod: 'Manual - Paid',
    notes: '5 Split the Pot tickets for $50.'
  },
  {
    type: 'split-pot',
    name: 'Moshe Franco',
    phoneNumber: '917-635-6681',
    ticketCount: 1,
    amountPaid: 10,
    paymentMethod: 'Manual - Paid',
    notes: '1 Split the Pot ticket.'
  },
  {
    type: 'rolex',
    name: 'Sammy Levy',
    phoneNumber: '347-579-9559',
    ticketCount: 1,
    amountPaid: 150,
    paymentMethod: 'Manual - Paid',
    referrerName: 'Daniel Khafif',
    notes: '1 Rolex ticket referred by Daniel Khafif.'
  },
  {
    type: 'split-pot',
    name: 'Shilla Hamra',
    phoneNumber: '917-660-0315',
    ticketCount: 5,
    amountPaid: 50,
    paymentMethod: 'Zelle',
    notes: '5 Split the Pot tickets paid via Zelle.'
  },
  {
    type: 'split-pot',
    name: 'Sondra Franco',
    phoneNumber: '917-692-7130',
    ticketCount: 1,
    amountPaid: 10,
    paymentMethod: 'Manual - Paid',
    notes: '1 Split the Pot ticket.'
  }
];

async function main() {
  const referrerLookup = await loadReferrers();

  const batch = db.batch();
  const splitPotTotals = { tickets: 0, amount: 0 };
  const referrerTotals = new Map();

  for (const entry of entries) {
    const firstName = entry.name.split(/\s+/)[0];
    const { referrerUid, referrerRefId, referrerName } = resolveReferrer(referrerLookup, entry.referrerName);

    if (entry.type === 'split-pot') {
      const docRef = db.collection('splitThePotTickets').doc();

      batch.set(docRef, {
        fullName: entry.name,
        firstName,
        phoneNumber: entry.phoneNumber || null,
        email: null,
        referrerRefId,
        referrerUid,
        referrerName,
        amountPaid: entry.amountPaid,
        ticketCount: entry.ticketCount,
        paymentMethod: entry.paymentMethod || 'Manual',
        notes: entry.notes || null,
        timestamp: FieldValue.serverTimestamp(),
        entryType: 'manual',
        sourceApp: 'Manual Sales Script'
      });

      splitPotTotals.tickets += entry.ticketCount;
      splitPotTotals.amount += entry.amountPaid;

      if (referrerUid) {
        const existing = referrerTotals.get(referrerUid) || { tickets: 0, amount: 0 };
        existing.tickets += entry.ticketCount;
        existing.amount += entry.amountPaid;
        referrerTotals.set(referrerUid, existing);
      }
    } else if (entry.type === 'rolex') {
      const docRef = db.collection('rolex_entries').doc();

      batch.set(docRef, {
        paymentIntentId: null,
        name: entry.name,
        firstName,
        email: null,
        phoneNumber: entry.phoneNumber || null,
        ticketsBought: entry.ticketCount,
        amountPaid: entry.amountPaid,
        chargedAmount: entry.amountPaid,
        status: 'paid',
        paymentMethod: entry.paymentMethod || 'Manual',
        notes: entry.notes || null,
        timestamp: FieldValue.serverTimestamp(),
        sourceApp: 'Manual Sales Script',
        referrerRefId,
        referrerUid,
        referrerName
      });
    } else {
      throw new Error(`Unsupported entry type: ${entry.type}`);
    }
  }

  if (splitPotTotals.tickets > 0 || splitPotTotals.amount > 0) {
    const raffleCounterRef = db.collection('counters').doc('raffle_totals');
    batch.set(raffleCounterRef, {
      totalTickets: FieldValue.increment(splitPotTotals.tickets),
      totalAmount: FieldValue.increment(splitPotTotals.amount),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  for (const [uid, totals] of referrerTotals.entries()) {
    const referrerRef = db.collection('referrers').doc(uid);
    const update = {
      lastSaleTimestamp: FieldValue.serverTimestamp()
    };

    if (totals.tickets > 0) {
      update.totalTickets = FieldValue.increment(totals.tickets);
    }

    if (totals.amount > 0) {
      update.totalAmount = FieldValue.increment(totals.amount);
    }

    batch.set(referrerRef, update, { merge: true });
  }

  await batch.commit();

  console.log('Successfully queued manual sales:');
  entries.forEach(entry => {
    console.log(` - ${entry.type === 'rolex' ? 'Rolex' : 'Split Pot'}: ${entry.name} (${entry.ticketCount} ticket${entry.ticketCount !== 1 ? 's' : ''})`);
  });

  console.log('\nTotals applied to counters:');
  console.log(` • Split the Pot Tickets: ${splitPotTotals.tickets}`);
  console.log(` • Split the Pot Amount: $${splitPotTotals.amount.toFixed(2)}`);
  console.log('Rolex counters will be updated automatically by Firestore triggers.');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Failed to record manual sales:', error);
    process.exit(1);
  });
