import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js';
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
const createPaymentIntent = httpsCallable(getFunctions(app), 'createAuctionPaymentIntent');
const getAuctionStripeConfig = httpsCallable(getFunctions(app), 'getAuctionStripeConfig');
const { auctionPackages, pageHeader } = window.AUCTION_DATA;
const sortedPackages = [...auctionPackages].sort((a, b) => {
  const priceDiff = Number(a.price || 0) - Number(b.price || 0);
  if (priceDiff !== 0) return priceDiff;
  return Number(a.number || 0) - Number(b.number || 0);
});

let stripe = null;

const packageWrap = document.getElementById('packages');
const err = document.getElementById('err');
const summaryRows = document.getElementById('summaryRows');
const summaryEmpty = document.getElementById('summaryEmpty');
const totalEntriesEl = document.getElementById('totalEntries');
const checkoutTotalEl = document.getElementById('checkoutTotal');
const checkoutBtn = document.getElementById('checkout');
const nameEl = document.getElementById('name');
const emailEl = document.getElementById('email');
const phoneEl = document.getElementById('phone');
const paymentSectionEl = document.getElementById('auctionPaymentSection');
const paymentElementContainerEl = document.getElementById('auctionPaymentElementContainer');
const stripePayBtn = document.getElementById('auctionStripePayButton');
const raffleSubtitleEl = document.getElementById('raffleSubtitle');
const raffleTaglineEl = document.getElementById('raffleTagline');

const packageQtyState = Object.fromEntries(auctionPackages.map((pkg) => [pkg.id, 0]));
const quantityInputs = {};
let stripeElements = null;
let activeOrderId = '';
let activePaymentIntentId = '';

const ensureAuctionStripe = async () => {
  if (stripe) return stripe;
  const response = await getAuctionStripeConfig({});
  const publishableKey = response?.data?.publishableKey;
  if (!publishableKey) {
    throw new Error('Auction Stripe publishable key is missing.');
  }
  stripe = Stripe(publishableKey);
  return stripe;
};

const packageThemes = [
  {
    card: 'from-rose-900/45 to-rose-700/15 border-rose-300/30',
    chip: 'bg-rose-400/20 text-rose-100 border-rose-200/35'
  },
  {
    card: 'from-sky-900/45 to-sky-700/15 border-sky-300/30',
    chip: 'bg-sky-400/20 text-sky-100 border-sky-200/35'
  },
  {
    card: 'from-emerald-900/45 to-emerald-700/15 border-emerald-300/30',
    chip: 'bg-emerald-400/20 text-emerald-100 border-emerald-200/35'
  },
  {
    card: 'from-amber-900/45 to-amber-700/15 border-amber-300/30',
    chip: 'bg-amber-400/20 text-amber-100 border-amber-200/35'
  },
  {
    card: 'from-indigo-900/45 to-indigo-700/15 border-indigo-300/30',
    chip: 'bg-indigo-400/20 text-indigo-100 border-indigo-200/35'
  }
];

const toMoney = (value) => `$${Number(value || 0).toFixed(2)}`;

const getLineItems = () => {
  return sortedPackages
    .map((pkg) => {
      const quantity = Number(packageQtyState[pkg.id] || 0);
      if (quantity <= 0) return null;
      const total = quantity * Number(pkg.price || 0);
      return {
        packageId: pkg.id,
        name: pkg.name,
        quantity,
        unitPrice: Number(pkg.price || 0),
        total
      };
    })
    .filter(Boolean);
};

const getTotals = () => {
  const lineItems = getLineItems();
  return lineItems.reduce((acc, line) => {
    acc.total += line.total;
    acc.entries += line.quantity;
    return acc;
  }, { total: 0, entries: 0, lineItems });
};

const updateCheckoutEnabledState = () => {
  const { entries } = getTotals();
  const hasCustomer = Boolean(nameEl.value.trim() && emailEl.value.trim() && phoneEl.value.trim());
  checkoutBtn.disabled = !hasCustomer || entries < 1;
};

const renderSummary = () => {
  const { total, entries, lineItems } = getTotals();

  totalEntriesEl.textContent = String(entries);
  checkoutTotalEl.textContent = toMoney(total);

  if (!lineItems.length) {
    summaryRows.innerHTML = '';
    summaryEmpty.classList.remove('hidden');
    updateCheckoutEnabledState();
    return;
  }

  summaryEmpty.classList.add('hidden');
  summaryRows.innerHTML = lineItems.map((line) => `
    <div class="rounded-xl border border-slate-700/80 bg-slate-900/75 p-3">
      <div class="flex items-center justify-between gap-3">
        <p class="text-sm text-slate-100">
          <span class="font-semibold text-white">${line.name}</span>
          <span class="text-slate-400"> · ${line.quantity} x ${toMoney(line.unitPrice)}</span>
        </p>
        <p class="text-sm font-semibold text-amber-300">${toMoney(line.total)}</p>
      </div>
    </div>
  `).join('');

  updateCheckoutEnabledState();
};

const resetPaymentSection = () => {
  if (!paymentSectionEl || !paymentElementContainerEl) return;
  paymentSectionEl.style.display = 'none';
  paymentElementContainerEl.innerHTML = '';
  stripeElements = null;
  activeOrderId = '';
  activePaymentIntentId = '';
  stripePayBtn.disabled = false;
  stripePayBtn.textContent = 'Pay Now';
  checkoutBtn.textContent = 'Checkout';
  updateCheckoutEnabledState();
};

const setPackageQty = (packageId, qty) => {
  if (!(packageId in packageQtyState)) return;
  packageQtyState[packageId] = Math.max(0, Math.floor(Number(qty) || 0));
  if (quantityInputs[packageId]) {
    quantityInputs[packageId].value = String(packageQtyState[packageId]);
  }
  renderSummary();
  resetPaymentSection();
};

const renderPageHeader = () => {
  if (!pageHeader) return;
  if (raffleSubtitleEl) raffleSubtitleEl.textContent = pageHeader.subtitle || '';
  if (raffleTaglineEl) raffleTaglineEl.textContent = pageHeader.tagline || '';
};

const createQtyControlMarkup = (pkg) => {
  return `
    <div class="mt-4 rounded-xl border border-white/15 bg-slate-950/35 p-3">
      <p class="text-[11px] uppercase tracking-[0.18em] text-slate-300">Entries</p>
      <div class="mt-2 grid grid-cols-[44px_1fr_44px] gap-2 items-center">
        <button type="button" data-action="dec" data-id="${pkg.id}" class="h-11 rounded-lg border border-slate-500 bg-slate-800/80 text-xl font-bold text-white hover:bg-slate-700">-</button>
        <input type="number" min="0" step="1" inputmode="numeric" data-id="${pkg.id}" data-role="qty-input" class="h-11 rounded-lg border border-slate-500 bg-slate-950/80 px-3 text-center text-lg font-semibold text-white focus:outline-none focus:ring-2 focus:ring-amber-300" value="0">
        <button type="button" data-action="inc" data-id="${pkg.id}" class="h-11 rounded-lg border border-amber-300/70 bg-amber-300/20 text-xl font-bold text-amber-100 hover:bg-amber-300/30">+</button>
      </div>
      <p class="mt-2 text-sm text-slate-300">Line total: <span data-role="line-total" data-id="${pkg.id}" class="font-semibold text-amber-200">$0.00</span></p>
    </div>
  `;
};

const syncLineTotals = () => {
  sortedPackages.forEach((pkg) => {
    const qty = Number(packageQtyState[pkg.id] || 0);
    const lineTotal = qty * Number(pkg.price || 0);
    const lineTotalEl = packageWrap.querySelector(`[data-role="line-total"][data-id="${pkg.id}"]`);
    if (lineTotalEl) lineTotalEl.textContent = toMoney(lineTotal);
  });
};

sortedPackages.forEach((pkg, index) => {
  const theme = packageThemes[index % packageThemes.length];
  const card = document.createElement('div');
  card.className = `rounded-2xl p-5 border bg-gradient-to-br transition-transform duration-200 hover:-translate-y-0.5 ${theme.card}`;
  card.innerHTML = `
    <div class="flex items-start justify-between gap-4">
      <div>
        <p class="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.15em] ${theme.chip}">Package ${pkg.number}</p>
        <h3 class="mt-2 font-semibold text-2xl leading-tight text-white">${pkg.name}</h3>
        ${pkg.titleText ? `<p class="mt-1 text-sm text-slate-100">${pkg.titleText}</p>` : ''}
        ${pkg.sponsor ? `<p class="mt-1 text-xs text-slate-300">${pkg.sponsor}</p>` : ''}
      </div>
      <div class="text-right">
        <p class="text-xs uppercase tracking-[0.15em] text-slate-300">Entry Price</p>
        <p class="text-2xl font-bold text-amber-300">${toMoney(pkg.price)}</p>
        <p class="mt-1 text-xs text-slate-300">Value ${pkg.value}</p>
      </div>
    </div>
    ${pkg.items?.length ? `<ul class="mt-4 text-sm space-y-1.5 text-slate-100 border-t border-white/15 pt-4">${pkg.items.map((item) => `<li>• ${item}</li>`).join('')}</ul>` : ''}
    ${createQtyControlMarkup(pkg)}
  `;

  card.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action][data-id]');
    if (!button) return;
    const packageId = button.dataset.id;
    const delta = button.dataset.action === 'inc' ? 1 : -1;
    setPackageQty(packageId, Number(packageQtyState[packageId] || 0) + delta);
    syncLineTotals();
  });

  const qtyInput = card.querySelector('input[data-role="qty-input"]');
  if (qtyInput) {
    quantityInputs[pkg.id] = qtyInput;
    qtyInput.addEventListener('input', () => {
      setPackageQty(pkg.id, qtyInput.value);
      syncLineTotals();
    });
  }

  packageWrap.appendChild(card);
});
renderPageHeader();
renderSummary();
syncLineTotals();

checkoutBtn.addEventListener('click', async () => {
  err.textContent = '';
  const name = nameEl.value.trim();
  const email = emailEl.value.trim();
  const phone = phoneEl.value.trim();
  const { total, entries, lineItems } = getTotals();
  const entriesByPackage = Object.fromEntries(sortedPackages.map((pkg) => [pkg.id, Number(packageQtyState[pkg.id] || 0)]));

  if (!name || !email || !phone || entries < 1) {
    err.textContent = 'Please enter your name, email, phone, and at least one package entry.';
    return;
  }

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Preparing payment...';
  try {
    const stripeInstance = await ensureAuctionStripe();
    const payload = {
      customer: { name, email, phone },
      entries: entriesByPackage,
      lineItems,
      total
    };

    const response = await createPaymentIntent(payload);
    const clientSecret = response?.data?.clientSecret;
    activeOrderId = response?.data?.orderId || '';
    activePaymentIntentId = response?.data?.paymentIntentId || '';

    if (!clientSecret) throw new Error('No client secret returned.');

    stripeElements = stripeInstance.elements({
      clientSecret,
      appearance: {
        theme: 'night',
        variables: {
          colorPrimary: '#facc15'
        }
      }
    });

    const paymentElement = stripeElements.create('payment');
    paymentElement.mount('#auctionPaymentElementContainer');

    const safeTotalAmount = Number(total || 0);
    paymentSectionEl.style.display = 'block';
    stripePayBtn.textContent = `Pay $${safeTotalAmount.toFixed(2)}`;
    checkoutBtn.textContent = 'Payment Ready';
    err.textContent = '';
  } catch (e) {
    const detailText = typeof e?.details === 'string'
      ? e.details
      : (e?.details && typeof e.details.message === 'string' ? e.details.message : '');
    const suffix = detailText ? ` (${detailText})` : '';
    err.textContent = `${e?.message || 'Checkout failed. Please try again.'}${suffix}`;
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Checkout';
  }
});

stripePayBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  if (!stripeElements || !activeOrderId) {
    err.textContent = 'Please prepare payment first.';
    return;
  }

  err.textContent = '';
  stripePayBtn.disabled = true;
  stripePayBtn.textContent = 'Processing...';

  const returnUrl = `${window.location.origin}/auction/success/?orderId=${encodeURIComponent(activeOrderId)}`;
  const result = await stripe.confirmPayment({
    elements: stripeElements,
    confirmParams: { return_url: returnUrl },
    redirect: 'if_required'
  });

  if (result.error) {
    err.textContent = result.error.message || 'Payment failed. Please try again.';
    stripePayBtn.disabled = false;
    stripePayBtn.textContent = 'Pay Now';
    return;
  }

  if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
    const pi = encodeURIComponent(result.paymentIntent.id);
    window.location.href = `/auction/success/?orderId=${encodeURIComponent(activeOrderId)}&payment_intent=${pi}`;
    return;
  }

  // If Stripe handled a redirect-required flow, control may leave the page.
  stripePayBtn.disabled = false;
  stripePayBtn.textContent = 'Pay Now';
});

nameEl.addEventListener('input', resetPaymentSection);
emailEl.addEventListener('input', resetPaymentSection);
phoneEl.addEventListener('input', resetPaymentSection);
nameEl.addEventListener('input', updateCheckoutEnabledState);
emailEl.addEventListener('input', updateCheckoutEnabledState);
phoneEl.addEventListener('input', updateCheckoutEnabledState);
