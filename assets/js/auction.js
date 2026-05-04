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
const createCheckout = httpsCallable(getFunctions(app), 'createAuctionCheckoutSession');
const { ticketBundles, auctionPackages } = window.AUCTION_DATA;

const bundleWrap = document.getElementById('bundles');
const packageWrap = document.getElementById('packages');
const err = document.getElementById('err');
const selectedBundleLabel = document.getElementById('selectedBundleLabel');
const selectionBreakdown = document.getElementById('selectionBreakdown');
const checkoutTotalEl = document.getElementById('checkoutTotal');
const checkoutBtn = document.getElementById('checkout');
const nameEl = document.getElementById('name');
const emailEl = document.getElementById('email');
const phoneEl = document.getElementById('phone');

const bundleState = {};
const bundleCards = {};
const bundleQtyEls = {};

const packageThemes = [
  {
    card: 'bg-emerald-950/45 border-emerald-400/35',
    title: 'text-emerald-300',
    value: 'text-emerald-100/90',
    list: 'text-emerald-50'
  },
  {
    card: 'bg-sky-950/45 border-sky-400/35',
    title: 'text-sky-300',
    value: 'text-sky-100/90',
    list: 'text-sky-50'
  },
  {
    card: 'bg-fuchsia-950/35 border-fuchsia-400/35',
    title: 'text-fuchsia-300',
    value: 'text-fuchsia-100/90',
    list: 'text-fuchsia-50'
  },
  {
    card: 'bg-amber-950/45 border-amber-400/35',
    title: 'text-amber-300',
    value: 'text-amber-100/90',
    list: 'text-amber-50'
  }
];

const bundleThemes = [
  {
    card: 'bg-gradient-to-br from-rose-500/20 to-rose-900/25 border-rose-300/45',
    qty: 'text-rose-100',
    active: 'ring-2 ring-rose-300/80'
  },
  {
    card: 'bg-gradient-to-br from-blue-500/20 to-blue-900/25 border-blue-300/45',
    qty: 'text-blue-100',
    active: 'ring-2 ring-blue-300/80'
  },
  {
    card: 'bg-gradient-to-br from-emerald-500/20 to-emerald-900/25 border-emerald-300/45',
    qty: 'text-emerald-100',
    active: 'ring-2 ring-emerald-300/80'
  },
  {
    card: 'bg-gradient-to-br from-amber-500/20 to-amber-900/25 border-amber-300/45',
    qty: 'text-amber-100',
    active: 'ring-2 ring-amber-300/80'
  }
];

const setBundleState = (next) => {
  Object.keys(bundleState).forEach((k) => delete bundleState[k]);
  Object.entries(next).forEach(([bundleId, qty]) => {
    if (Number(qty) > 0) bundleState[bundleId] = Number(qty);
  });
};

const getCheapestCombination = (ticketTarget) => {
  const target = Math.max(0, Number(ticketTarget) || 0);
  const dp = Array(target + 1).fill(null);
  dp[0] = { cost: 0, counts: {} };

  for (let tickets = 1; tickets <= target; tickets += 1) {
    let best = null;

    for (const bundle of ticketBundles) {
      const prevTickets = tickets - bundle.ticketCount;
      if (prevTickets < 0 || !dp[prevTickets]) continue;

      const prev = dp[prevTickets];
      const candidateCost = prev.cost + bundle.price;

      if (!best || candidateCost < best.cost) {
        best = {
          cost: candidateCost,
          counts: {
            ...prev.counts,
            [bundle.id]: Number(prev.counts[bundle.id] || 0) + 1
          }
        };
      }
    }

    dp[tickets] = best;
  }

  return dp[target]?.counts || {};
};

const getBundleTotals = () => {
  return ticketBundles.reduce((acc, bundle) => {
    const qty = Number(bundleState[bundle.id] || 0);
    acc.totalTickets += qty * bundle.ticketCount;
    acc.totalAmount += qty * bundle.price;
    return acc;
  }, { totalTickets: 0, totalAmount: 0 });
};

const refreshBundleUI = () => {
  ticketBundles.forEach((bundle, idx) => {
    const qty = Number(bundleState[bundle.id] || 0);
    const card = bundleCards[bundle.id];
    const qtyEl = bundleQtyEls[bundle.id];

    if (qtyEl) qtyEl.textContent = String(qty);
    if (card) {
      const activeClasses = bundleThemes[idx % bundleThemes.length].active.split(' ');
      activeClasses.forEach((cls) => card.classList.toggle(cls, qty > 0));
    }
  });
};

const renderSelectionSummary = () => {
  const { totalTickets, totalAmount } = getBundleTotals();

  if (checkoutTotalEl) {
    checkoutTotalEl.textContent = `$${totalAmount.toFixed(2)}`;
  }

  if (totalTickets === 0) {
    selectedBundleLabel.textContent = 'No bundle selected';
    if (selectionBreakdown) selectionBreakdown.innerHTML = '';
    return;
  }

  selectedBundleLabel.textContent = `Selected: ${totalTickets} tickets for $${totalAmount}`;

  if (!selectionBreakdown) return;
  const rows = ticketBundles
    .filter((bundle) => Number(bundleState[bundle.id] || 0) > 0)
    .map((bundle) => {
      const qty = Number(bundleState[bundle.id] || 0);
      const ticketWord = bundle.ticketCount === 1 ? 'ticket' : 'tickets';
      return `<p>${qty} x ${bundle.ticketCount} ${ticketWord} ($${bundle.price} each) = $${qty * bundle.price}</p>`;
    });

  selectionBreakdown.innerHTML = rows.join('');
};

const applyTicketDelta = (deltaTickets) => {
  const { totalTickets } = getBundleTotals();
  const nextTickets = Math.max(0, totalTickets + deltaTickets);
  const optimizedCounts = getCheapestCombination(nextTickets);

  setBundleState(optimizedCounts);
  refreshBundleUI();
  renderSelectionSummary();
};

auctionPackages.forEach((pkg, index) => {
  const theme = packageThemes[index % packageThemes.length];
  const card = document.createElement('div');
  card.className = `rounded-xl p-5 border transition-transform duration-200 hover:-translate-y-0.5 ${theme.card}`;
  card.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4 md:gap-6">
      <div class="md:w-64 md:flex-shrink-0">
        <h3 class="font-semibold text-2xl leading-tight ${theme.title}">${pkg.name}</h3>
        <p class="mt-2 text-sm ${theme.value}">Value: ${pkg.value}</p>
      </div>
      <ul class="text-sm space-y-1.5 ${theme.list} md:flex-1 md:border-l md:border-white/15 md:pl-5">
        ${pkg.prizes.map((p) => `<li>• ${p}</li>`).join('')}
      </ul>
    </div>
  `;
  packageWrap.appendChild(card);
});

ticketBundles.forEach((bundle, index) => {
  const theme = bundleThemes[index % bundleThemes.length];
  const card = document.createElement('div');
  card.className = `bundle border rounded-2xl p-4 transition-all duration-200 ${theme.card}`;
  card.innerHTML = `
    <div>
      <p class="text-5xl font-bold text-white leading-none">${bundle.ticketCount}</p>
      <p class="text-xl uppercase tracking-wider text-slate-200 mt-1">Ticket${bundle.ticketCount > 1 ? 's' : ''}</p>
      <p class="text-5xl font-semibold text-yellow-100 mt-2">$${bundle.price}</p>
    </div>
    <div class="mt-4 grid grid-cols-3 items-center gap-2 border border-white/20 rounded-lg bg-slate-950/40 px-2 py-2">
      <button type="button" data-action="dec" data-id="${bundle.id}" class="h-10 rounded-md bg-white/10 hover:bg-white/20 text-white font-bold text-lg">-</button>
      <p class="text-center ${theme.qty}"><span class="text-xs uppercase block tracking-widest text-slate-300">Quantity</span><span id="qty-${bundle.id}" class="text-2xl font-bold">0</span></p>
      <button type="button" data-action="inc" data-id="${bundle.id}" class="h-10 rounded-md bg-white/10 hover:bg-white/20 text-white font-bold text-lg">+</button>
    </div>
  `;

  bundleCards[bundle.id] = card;
  bundleQtyEls[bundle.id] = card.querySelector(`#qty-${bundle.id}`);

  card.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    if (action === 'inc') applyTicketDelta(bundle.ticketCount);
    if (action === 'dec') applyTicketDelta(-bundle.ticketCount);
  });

  bundleWrap.appendChild(card);
});

setBundleState({});
refreshBundleUI();
renderSelectionSummary();

checkoutBtn.addEventListener('click', async () => {
  err.textContent = '';
  const name = nameEl.value.trim();
  const email = emailEl.value.trim();
  const phone = phoneEl.value.trim();
  const selected = Object.fromEntries(Object.entries(bundleState).filter(([, qty]) => Number(qty) > 0));
  const selectedBundleIds = Object.keys(selected);
  const legacyTicketBundleId = selectedBundleIds.length === 1 ? selectedBundleIds[0] : null;
  const { totalTickets } = getBundleTotals();

  if (!name || !email || !phone || totalTickets < 1) {
    err.textContent = 'Please complete all fields and select at least 1 ticket.';
    return;
  }

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Preparing checkout...';
  try {
    const payload = { name, email, phone, bundleSelections: selected };
    if (legacyTicketBundleId) payload.ticketBundleId = legacyTicketBundleId;

    const response = await createCheckout(payload);
    if (!response?.data?.url) throw new Error('No checkout URL returned.');
    window.location.href = response.data.url;
  } catch (e) {
    const detailText = typeof e?.details === 'string'
      ? e.details
      : (e?.details && typeof e.details.message === 'string' ? e.details.message : '');
    const suffix = detailText ? ` (${detailText})` : '';
    err.textContent = `${e?.message || 'Checkout failed. Please try again.'}${suffix}`;
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Proceed to Payment';
  }
});
