import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js';
import { getFirestore, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAT539nr_s2OxHPTAmkxwMpaWt-FiDTgQs',
  authDomain: 'yderaffle.firebaseapp.com',
  projectId: 'yderaffle',
  storageBucket: 'yderaffle.firebasestorage.app',
  messagingSenderId: '967768309102',
  appId: '1:967768309102:web:c89d61a747e8cb941f557f'
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const confirmAuctionPaymentFn = httpsCallable(getFunctions(app), 'confirmAuctionPaymentIntentPaid');

const statusEl = document.getElementById('status');
const confirmationBox = document.getElementById('confirmationBox');
const entryRowsEl = document.getElementById('entryRows');
const totalPaidEl = document.getElementById('totalPaid');

const packageMap = new Map((window.AUCTION_DATA?.auctionPackages || []).map((pkg) => [pkg.id, pkg]));

const toMoney = (value) => `$${Number(value || 0).toFixed(2)}`;

const findOrderByPaymentIntentId = async (paymentIntentId) => {
  const intentQuery = query(collection(db, 'auctionOrders'), where('paymentIntentId', '==', paymentIntentId));
  const snap = await getDocs(intentQuery);
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
};

const findOrderBySessionId = async (sessionId) => {
  const sessionQuery = query(collection(db, 'auctionOrders'), where('stripeSessionId', '==', sessionId));
  const snap = await getDocs(sessionQuery);
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
};

const findOrderByOrderId = async (orderId) => {
  const orderQuery = query(collection(db, 'auctionOrders'), where('orderId', '==', orderId));
  const snap = await getDocs(orderQuery);
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
};

const buildFallbackLinesFromEntries = (entries) => {
  const lines = [];
  Object.entries(entries || {}).forEach(([packageId, qtyRaw]) => {
    const quantity = Number(qtyRaw || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    const pkg = packageMap.get(packageId);
    const unitPrice = Number(pkg?.price || 0);
    lines.push({
      packageId,
      name: pkg?.name || packageId,
      quantity,
      unitPrice,
      total: quantity * unitPrice
    });
  });

  return lines;
};

const renderOrder = (order) => {
  const lineItems = Array.isArray(order.lineItems) && order.lineItems.length
    ? order.lineItems
    : buildFallbackLinesFromEntries(order.entries || {});

  if (!lineItems.length) {
    entryRowsEl.innerHTML = '<p class="text-sm text-slate-300">No package entries were found in this order.</p>';
    totalPaidEl.textContent = toMoney(order.total || order.amountPaid || 0);
    return;
  }

  entryRowsEl.innerHTML = lineItems.map((line) => {
    return `
      <div class="rounded-lg border border-slate-700 bg-slate-950/70 p-3 flex items-center justify-between gap-3">
        <div>
          <p class="font-semibold text-white">${line.name}</p>
          <p class="text-xs text-slate-300">${line.quantity} x ${toMoney(line.unitPrice)}</p>
        </div>
        <p class="font-semibold text-yellow-300">${toMoney(line.total)}</p>
      </div>
    `;
  }).join('');

  const total = Number(order.total || order.amountPaid || 0);
  totalPaidEl.textContent = toMoney(total);
};

const run = async () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id') || '';
  const paymentIntentId = params.get('payment_intent') || '';
  const orderId = params.get('orderId') || '';

  if (!sessionId && !paymentIntentId && !orderId) {
    statusEl.textContent = 'No order reference found. Please return to the auction page.';
    return;
  }

  statusEl.textContent = 'Confirming your payment details...';
  let order = null;

  if (paymentIntentId) order = await findOrderByPaymentIntentId(paymentIntentId);
  if (!order && sessionId) order = await findOrderBySessionId(sessionId);
  if (!order && orderId) order = await findOrderByOrderId(orderId);

  if (!order) {
    statusEl.textContent = 'Payment is still being confirmed. Please refresh in a few seconds.';
    return;
  }

  if (order.status !== 'paid' && paymentIntentId) {
    try {
      await confirmAuctionPaymentFn({ orderId: order.orderId || order.id, paymentIntentId });
      const refreshed = await findOrderByPaymentIntentId(paymentIntentId);
      if (refreshed) order = refreshed;
    } catch (error) {
      statusEl.textContent = error?.message || 'Payment is still being confirmed. Please refresh in a few seconds.';
      return;
    }
  }

  if (order.status !== 'paid') {
    statusEl.textContent = 'Payment is still being confirmed. Please refresh in a few seconds.';
    return;
  }

  statusEl.textContent = 'Payment confirmed and entries saved.';
  renderOrder(order);
  confirmationBox.classList.remove('hidden');
};

run().catch((error) => {
  statusEl.textContent = error?.message || 'Unable to load order details.';
});
