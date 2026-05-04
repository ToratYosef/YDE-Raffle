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
const submitFn = httpsCallable(getFunctions(app), 'submitAuctionAllocation');

const COOKIE_NAME = 'auction_pending_order';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

const statusEl = document.getElementById('status');
const confirmationBox = document.getElementById('confirmationBox');
const modalOverlay = document.getElementById('allocationModalOverlay');
const allocationRows = document.getElementById('allocationRows');
const allocationSummary = document.getElementById('allocationSummary');
const remainingLabel = document.getElementById('remainingLabel');
const submitBtn = document.getElementById('submitAllocationBtn');
const allocationErr = document.getElementById('allocationErr');

const packageList = (window.AUCTION_DATA?.auctionPackages || []).map((pkg) => ({ id: pkg.id, name: pkg.name }));

const setCookie = (name, value, maxAge) => {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; samesite=lax`;
};

const getCookie = (name) => {
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return '';
  return decodeURIComponent(match.substring(name.length + 1));
};

const clearCookie = (name) => {
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
};

const setPendingOrderCookie = (data) => {
  setCookie(COOKIE_NAME, JSON.stringify(data), COOKIE_MAX_AGE);
};

const getPendingOrderCookie = () => {
  const raw = getCookie(COOKIE_NAME);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const showSubmittedState = () => {
  statusEl.textContent = 'Your ticket allocation is complete.';
  confirmationBox.classList.remove('hidden');
  modalOverlay.classList.add('hidden');
};

const findOrderBySessionId = async (sessionId) => {
  const sessionQuery = query(collection(db, 'auctionOrders'), where('stripeSessionId', '==', sessionId));
  const snap = await getDocs(sessionQuery);
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
};

const buildAllocator = ({ order, sessionId }) => {
  const allocations = {};
  packageList.forEach((pkg) => {
    allocations[pkg.id] = 0;
  });

  const getTotalUsed = () => Object.values(allocations).reduce((sum, val) => sum + Number(val || 0), 0);
  const getRemaining = () => Number(order.ticketCount || 0) - getTotalUsed();

  const updateUiState = () => {
    const remaining = getRemaining();
    const atMax = remaining === 0;

    remainingLabel.textContent = `Remaining Tickets: ${remaining}`;
    remainingLabel.className = `text-lg font-semibold mt-1 ${atMax ? 'text-amber-300' : 'text-emerald-300'}`;

    submitBtn.disabled = remaining !== 0;

    allocationRows.querySelectorAll('button[data-role="inc"]').forEach((btn) => {
      btn.disabled = atMax;
      btn.classList.toggle('opacity-40', atMax);
      btn.classList.toggle('cursor-not-allowed', atMax);
    });
  };

  const renderRows = () => {
    allocationRows.innerHTML = packageList.map((pkg) => {
      const value = allocations[pkg.id] || 0;
      return `
        <div class="rounded-xl border border-slate-700 bg-slate-950/50 p-3 sm:p-4">
          <p class="font-semibold text-white text-base sm:text-lg">${pkg.name}</p>
          <div class="mt-3 grid grid-cols-3 gap-2 items-center">
            <button type="button" data-role="dec" data-package="${pkg.id}" class="h-10 rounded-md bg-white/10 hover:bg-white/20 text-lg font-bold">-</button>
            <p class="text-center text-slate-100"><span class="text-xs uppercase tracking-widest text-slate-400 block">Quantity</span><span id="qty-${pkg.id}" class="text-2xl font-bold">${value}</span></p>
            <button type="button" data-role="inc" data-package="${pkg.id}" class="h-10 rounded-md bg-white/10 hover:bg-white/20 text-lg font-bold">+</button>
          </div>
        </div>
      `;
    }).join('');

    updateUiState();
  };

  allocationRows.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-package]');
    if (!btn) return;

    const packageId = btn.dataset.package;
    const role = btn.dataset.role;

    if (!(packageId in allocations)) return;
    if (role === 'inc' && getRemaining() > 0) allocations[packageId] += 1;
    if (role === 'dec') allocations[packageId] = Math.max(0, allocations[packageId] - 1);

    const qtyEl = document.getElementById(`qty-${packageId}`);
    if (qtyEl) qtyEl.textContent = String(allocations[packageId]);
    updateUiState();
  });

  submitBtn.addEventListener('click', async () => {
    allocationErr.textContent = '';
    if (getRemaining() !== 0) {
      allocationErr.textContent = 'Please allocate all tickets before submitting.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    try {
      await submitFn({
        orderId: order.orderId || order.id,
        sessionId,
        allocations
      });

      clearCookie(COOKIE_NAME);
      window.location.href = '/auction/success/?submitted=1';
    } catch (error) {
      allocationErr.textContent = error?.message || 'Submission failed. Please try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Ticket Allocation';
      updateUiState();
    }
  });

  allocationSummary.textContent = `${order.name} | ${order.email} | ${order.phone} | Total Tickets: ${order.ticketCount}`;
  submitBtn.textContent = 'Submit Ticket Allocation';
  renderRows();
  modalOverlay.classList.remove('hidden');
};

const run = async () => {
  const params = new URLSearchParams(window.location.search);

  if (params.get('submitted') === '1') {
    clearCookie(COOKIE_NAME);
    showSubmittedState();
    return;
  }

  const cookieState = getPendingOrderCookie();
  const sessionId = params.get('session_id') || cookieState?.sessionId || '';

  if (!sessionId) {
    statusEl.textContent = 'No active payment session found. Please return to the auction page.';
    return;
  }

  statusEl.textContent = 'Confirming your payment details...';
  const order = await findOrderBySessionId(sessionId);

  if (!order) {
    statusEl.textContent = 'Payment is being confirmed. Please refresh in a few seconds.';
    return;
  }

  if (order.status === 'submitted') {
    clearCookie(COOKIE_NAME);
    showSubmittedState();
    return;
  }

  if (order.status !== 'paid') {
    statusEl.textContent = 'Payment is being confirmed. Please refresh in a few seconds.';
    return;
  }

  setPendingOrderCookie({
    orderId: order.orderId || order.id,
    sessionId,
    ticketCount: Number(order.ticketCount || 0),
    updatedAt: Date.now()
  });

  statusEl.textContent = 'Payment confirmed. Please allocate all tickets below.';
  buildAllocator({ order, sessionId });
};

run().catch((error) => {
  statusEl.textContent = error?.message || 'Unable to load ticket allocation.';
});
