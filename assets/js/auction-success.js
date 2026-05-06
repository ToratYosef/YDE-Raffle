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
const confirmAuctionPaymentFn = httpsCallable(getFunctions(app), 'confirmAuctionPaymentIntentPaid');

const COOKIE_NAME = 'auction_pending_order';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

const statusEl = document.getElementById('status');
const confirmationBox = document.getElementById('confirmationBox');
const modalOverlay = document.getElementById('allocationModalOverlay');
const allocationRows = document.getElementById('allocationRows');
const allocationSummary = document.getElementById('allocationSummary');
const remainingLabel = document.getElementById('remainingLabel');
const allocationTotalTickets = document.getElementById('allocationTotalTickets');
const allocationUsedTickets = document.getElementById('allocationUsedTickets');
const submitBtn = document.getElementById('submitAllocationBtn');
const allocationErr = document.getElementById('allocationErr');

const packageList = (window.AUCTION_DATA?.auctionPackages || []).map((pkg) => ({ id: pkg.id, name: pkg.name }));
let openTicketPrizeModal = null;
let typedBuffer = '';

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
  modalOverlay.classList.remove('flex');
};

const showAllocationError = (message) => {
  if (!message) {
    allocationErr.textContent = '';
    allocationErr.classList.add('hidden');
    return;
  }

  allocationErr.textContent = message;
  allocationErr.classList.remove('hidden');
};

const isAdminModeDetected = () => {
  const params = new URLSearchParams(window.location.search);
  if (window.location.pathname.startsWith('/auction/admin')) return true;
  if (params.get('admin') === '1') return true;

  try {
    return window.localStorage?.getItem('auctionAdminMode') === '1';
  } catch {
    return false;
  }
};

const setupAdminModalShortcut = () => {
  if (!isAdminModeDetected()) return;

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;

    const active = document.activeElement;
    const tag = active?.tagName?.toLowerCase();
    const isTypingField = tag === 'input' || tag === 'textarea' || active?.isContentEditable;
    if (isTypingField) return;
    if (typeof e.key !== 'string' || e.key.length !== 1) return;

    typedBuffer = (typedBuffer + e.key.toLowerCase()).slice(-20);
    if (typedBuffer.endsWith('modal')) {
      if (typeof openTicketPrizeModal === 'function') {
        openTicketPrizeModal();
      }
      typedBuffer = '';
    }
  });
};

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

const buildAllocator = ({ order, sessionId, paymentIntentId }) => {
  const totalTickets = Number(order.ticketCount || 0);
  const allocations = {};
  packageList.forEach((pkg) => {
    allocations[pkg.id] = Math.max(0, Number((order.allocations || {})[pkg.id] || 0));
  });

  const getTotalUsed = () => Object.values(allocations).reduce((sum, val) => sum + Number(val || 0), 0);
  const getRemaining = () => totalTickets - getTotalUsed();

  const setPackageValue = (packageId, nextValue) => {
    if (!(packageId in allocations)) return;

    const safeValue = Math.max(0, Math.floor(Number(nextValue) || 0));
    const maxForPackage = Math.max(0, totalTickets - (getTotalUsed() - allocations[packageId]));
    allocations[packageId] = Math.min(safeValue, maxForPackage);
  };

  const syncPackageInputs = () => {
    packageList.forEach((pkg) => {
      const currentValue = allocations[pkg.id] || 0;
      const qtyEl = allocationRows.querySelector(`[data-qty="${pkg.id}"]`);
      const inputEl = allocationRows.querySelector(`input[data-package-input="${pkg.id}"]`);
      const cardEl = allocationRows.querySelector(`[data-package-row="${pkg.id}"]`);
      if (qtyEl) qtyEl.textContent = String(currentValue);
      if (inputEl) inputEl.value = String(currentValue);

      if (cardEl) {
        cardEl.classList.toggle('border-cyan-400/70', currentValue > 0);
        cardEl.classList.toggle('bg-cyan-500/10', currentValue > 0);
        cardEl.classList.toggle('shadow-cyan-900/35', currentValue > 0);
        cardEl.classList.toggle('border-slate-700/80', currentValue === 0);
      }
    });
  };

  const updateUiState = () => {
    const remaining = getRemaining();
    const used = getTotalUsed();
    const atMax = remaining === 0;

    allocationTotalTickets.textContent = String(totalTickets);
    allocationUsedTickets.textContent = String(used);
    remainingLabel.textContent = String(remaining);
    remainingLabel.className = `text-xl font-bold ${remaining === 0 ? 'text-amber-300' : 'text-emerald-300'}`;

    const overAllocated = remaining < 0;
    const notComplete = remaining > 0;
    submitBtn.disabled = overAllocated || notComplete;

    if (overAllocated) {
      showAllocationError(`You allocated ${Math.abs(remaining)} too many tickets. Please reduce some entries.`);
    } else if (notComplete) {
      showAllocationError(`Assign ${remaining} more ticket${remaining === 1 ? '' : 's'} before submitting.`);
    } else {
      showAllocationError('');
    }

    allocationRows.querySelectorAll('button[data-role="inc"]').forEach((btn) => {
      const packageId = btn.dataset.package;
      const packageValue = allocations[packageId] || 0;
      const disableIncrease = atMax && packageValue <= 0;
      btn.disabled = disableIncrease;
      btn.classList.toggle('opacity-40', disableIncrease);
      btn.classList.toggle('cursor-not-allowed', disableIncrease);
    });

    syncPackageInputs();
  };

  const renderRows = () => {
    allocationRows.innerHTML = packageList.map((pkg) => {
      const value = allocations[pkg.id] || 0;
      return `
        <div data-package-row="${pkg.id}" class="rounded-2xl border border-slate-700/80 bg-slate-950/55 p-3.5 sm:p-4 transition-all duration-200 shadow-lg shadow-black/20">
          <div class="flex items-start justify-between gap-2">
            <p class="font-semibold text-white text-base sm:text-lg leading-tight">${pkg.name}</p>
            <span class="text-[10px] uppercase tracking-widest rounded-full border border-slate-600 px-2 py-1 text-slate-300">Prize</span>
          </div>

          <div class="mt-3 grid grid-cols-[44px_1fr_44px] gap-2 items-center">
            <button type="button" data-role="dec" data-package="${pkg.id}" class="h-11 rounded-lg border border-slate-600 bg-slate-800/90 hover:bg-slate-700 text-xl font-bold text-white transition-colors">-</button>

            <div class="rounded-xl border border-slate-700 bg-slate-900/80 px-2.5 py-2">
              <label class="block text-[10px] uppercase tracking-widest text-slate-400">Tickets In This Prize</label>
              <div class="mt-1 flex items-center justify-between gap-2">
                <span data-qty="${pkg.id}" class="text-xl font-bold text-cyan-300 leading-none">${value}</span>
                <input data-package-input="${pkg.id}" type="number" min="0" inputmode="numeric" class="w-20 rounded-lg border border-slate-600 bg-slate-950 px-2.5 py-1.5 text-right text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400" value="${value}">
              </div>
            </div>

            <button type="button" data-role="inc" data-package="${pkg.id}" class="h-11 rounded-lg border border-cyan-500/60 bg-cyan-500/15 hover:bg-cyan-500/25 text-xl font-bold text-cyan-200 transition-colors">+</button>
          </div>
        </div>
      `;
    }).join('');

    updateUiState();
  };

  allocationRows.onclick = (event) => {
    const btn = event.target.closest('button[data-package]');
    if (!btn) return;

    const packageId = btn.dataset.package;
    const role = btn.dataset.role;

    if (!(packageId in allocations)) return;
    if (role === 'inc') setPackageValue(packageId, allocations[packageId] + 1);
    if (role === 'dec') setPackageValue(packageId, allocations[packageId] - 1);

    updateUiState();
  };

  allocationRows.oninput = (event) => {
    const input = event.target.closest('input[data-package-input]');
    if (!input) return;

    const packageId = input.dataset.packageInput;
    setPackageValue(packageId, input.value);
    updateUiState();
  };

  submitBtn.onclick = async () => {
    showAllocationError('');
    if (getRemaining() > 0) {
      showAllocationError('Please allocate all tickets before submitting.');
      return;
    }
    if (getRemaining() < 0) {
      showAllocationError('You allocated too many tickets. Please reduce entries and try again.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    try {
      await submitFn({
        orderId: order.orderId || order.id,
        sessionId,
        paymentIntentId,
        allocations
      });

      clearCookie(COOKIE_NAME);
      window.location.href = '/auction/success/?submitted=1';
    } catch (error) {
      showAllocationError(error?.message || 'Submission failed. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Ticket Allocation';
      updateUiState();
    }
  };

  allocationSummary.textContent = `${order.name} | ${order.email} | ${order.phone} | Total Tickets: ${order.ticketCount}`;
  submitBtn.textContent = 'Submit Ticket Allocation';
  renderRows();

  openTicketPrizeModal = () => {
    modalOverlay.classList.remove('hidden');
    modalOverlay.classList.add('flex');
  };

  openTicketPrizeModal();
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
  const paymentIntentId = params.get('payment_intent') || cookieState?.paymentIntentId || '';
  const orderIdFromParam = params.get('orderId') || cookieState?.orderId || '';

  if (!sessionId && !paymentIntentId && !orderIdFromParam) {
    statusEl.textContent = 'No active payment session found. Please return to the auction page.';
    return;
  }

  statusEl.textContent = 'Confirming your payment details...';
  let order = null;

  if (paymentIntentId) {
    order = await findOrderByPaymentIntentId(paymentIntentId);
  }
  if (!order && sessionId) {
    order = await findOrderBySessionId(sessionId);
  }
  if (!order && orderIdFromParam) {
    const orderDoc = await getDocs(query(collection(db, 'auctionOrders'), where('orderId', '==', orderIdFromParam)));
    if (!orderDoc.empty) order = { id: orderDoc.docs[0].id, ...orderDoc.docs[0].data() };
  }

  if (!order) {
    statusEl.textContent = 'Payment is being confirmed. Please refresh in a few seconds.';
    return;
  }

  if (order.status === 'submitted') {
    clearCookie(COOKIE_NAME);
    showSubmittedState();
    return;
  }

  if (order.status !== 'paid' && paymentIntentId && (order.orderId || order.id)) {
    try {
      await confirmAuctionPaymentFn({
        orderId: order.orderId || order.id,
        paymentIntentId
      });
      const refreshed = await findOrderByPaymentIntentId(paymentIntentId);
      if (refreshed) order = refreshed;
    } catch (error) {
      statusEl.textContent = error?.message || 'Payment is being confirmed. Please refresh in a few seconds.';
      return;
    }
  }

  if (order.status !== 'paid') {
    statusEl.textContent = 'Payment is being confirmed. Please refresh in a few seconds.';
    return;
  }

  setPendingOrderCookie({
    orderId: order.orderId || order.id,
    sessionId,
    paymentIntentId: paymentIntentId || order.paymentIntentId || '',
    ticketCount: Number(order.ticketCount || 0),
    updatedAt: Date.now()
  });

  statusEl.textContent = 'Payment confirmed. Please allocate all tickets below.';
  buildAllocator({ order, sessionId, paymentIntentId: paymentIntentId || order.paymentIntentId || '' });
};

run().catch((error) => {
  statusEl.textContent = error?.message || 'Unable to load ticket allocation.';
});

setupAdminModalShortcut();
