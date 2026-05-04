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

const selectedBundles = {};
const bundleWrap = document.getElementById('bundles');
const packageWrap = document.getElementById('packages');
const err = document.getElementById('err');
const selectedBundleLabel = document.getElementById('selectedBundleLabel');
const selectionBreakdown = document.getElementById('selectionBreakdown');
const checkoutBtn = document.getElementById('checkout');
const nameEl = document.getElementById('name');
const emailEl = document.getElementById('email');
const phoneEl = document.getElementById('phone');

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
  'bg-slate-900/70 border-rose-300/45 hover:border-rose-200/85',
  'bg-slate-900/70 border-sky-300/45 hover:border-sky-200/85',
  'bg-slate-900/70 border-emerald-300/45 hover:border-emerald-200/85',
  'bg-slate-900/70 border-amber-300/45 hover:border-amber-200/85'
];

const bundleState = {};
const bundleCards = {};
const bundleQtyEls = {};

const setBundleState = (next) => {
  Object.keys(bundleState).forEach((k) => delete bundleState[k]);
  Object.entries(next).forEach(([k, v]) => {
    if (v > 0) bundleState[k] = v;
  });
};

const getCheapestCombination = (ticketTarget) => {
  const maxTickets = Math.max(0, Number(ticketTarget) || 0);
  const dp = Array(maxTickets + 1).fill(null);
  dp[0] = { cost: 0, counts: {} };

  for (let tickets = 1; tickets <= maxTickets; tickets += 1) {
    let best = null;
    for (const bundle of ticketBundles) {
      const prevTickets = tickets - bundle.ticketCount;
      if (prevTickets < 0 || !dp[prevTickets]) continue;

      const prev = dp[prevTickets];
      const cost = prev.cost + bundle.price;
      if (!best || cost < best.cost) {
        best = {
          cost,
          counts: {
            ...prev.counts,
            [bundle.id]: Number(prev.counts[bundle.id] || 0) + 1
          }
        };
      }
    }
    dp[tickets] = best;
  }

  return dp[maxTickets]?.counts || {};
};

const getBundleTotals = () => {
  return ticketBundles.reduce((acc, bundle) => {
    const qty = Number(selectedBundles[bundle.id] || 0);
    acc.totalTickets += qty * bundle.ticketCount;
    acc.totalAmount += qty * bundle.price;
    return acc;
  }, { totalTickets: 0, totalAmount: 0 });
};

const renderSelectionSummary = () => {
  const { totalTickets, totalAmount } = getBundleTotals();
  if (totalTickets === 0) {
    selectedBundleLabel.textContent = 'No bundle selected';
    if (selectionBreakdown) selectionBreakdown.innerHTML = '';
    return;
  }

  selectedBundleLabel.textContent = `Selected: ${totalTickets} tickets for $${totalAmount}`;

  if (selectionBreakdown) {
    const lines = ticketBundles
      .filter((bundle) => Number(bundleState[bundle.id] || 0) > 0)
      .map((bundle) => {
        const qty = Number(bundleState[bundle.id] || 0);
        const countLabel = bundle.ticketCount === 1 ? 'ticket' : 'tickets';
        return `<p>${qty} x ${bundle.ticketCount} ${countLabel} ($${bundle.price} each) = $${qty * bundle.price}</p>`;
      });
    selectionBreakdown.innerHTML = lines.join('');
  }
};

const refreshBundleUI = () => {
  ticketBundles.forEach((bundle) => {
    const qty = Number(bundleState[bundle.id] || 0);
    const qtyEl = bundleQtyEls[bundle.id];
    const card = bundleCards[bundle.id];
    if (qtyEl) qtyEl.textContent = String(qty);
    if (card) {
      card.classList.toggle('ring-1', qty > 0);
      card.classList.toggle('ring-white/40', qty > 0);
    }
  });
};

const applyTicketDelta = (ticketDelta) => {
  const { totalTickets } = getBundleTotals();
  const nextTickets = Math.max(0, totalTickets + ticketDelta);
  const optimized = getCheapestCombination(nextTickets);
  setBundleState(optimized);
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
  card.className = `bundle border rounded-xl p-4 transition-all duration-200 ${theme}`;
  card.innerHTML = `
    <div class="flex items-center justify-between gap-4">
      <div class="text-left">
        <p class="text-3xl font-bold text-white leading-tight">${bundle.ticketCount}</p>
        <p class="text-sm uppercase tracking-wider text-slate-200">Ticket${bundle.ticketCount > 1 ? 's' : ''}</p>
        <p class="text-2xl font-semibold text-yellow-100 mt-1">$${bundle.price}</p>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" data-action="dec" data-id="${bundle.id}" class="h-9 w-9 rounded-full border border-white/30 text-xl leading-none text-white hover:bg-white/10">-</button>
        <span id="qty-${bundle.id}" class="min-w-8 text-center text-xl font-bold text-white">0</span>
        <button type="button" data-action="inc" data-id="${bundle.id}" class="h-9 w-9 rounded-full border border-white/30 text-xl leading-none text-white hover:bg-white/10">+</button>
      </div>
    </div>
  `;

  bundleCards[bundle.id] = card;
  bundleQtyEls[bundle.id] = card.querySelector(`#qty-${bundle.id}`);

  card.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    if (action === 'inc') {
      applyTicketDelta(bundle.ticketCount);
    } else if (action === 'dec') {
      applyTicketDelta(-bundle.ticketCount);
    }
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
  const selected = Object.fromEntries(
    Object.entries(bundleState).filter(([, qty]) => Number(qty) > 0)
  );
  const { totalTickets } = getBundleTotals();

  if (!name || !email || !phone || totalTickets < 1) {
    err.textContent = 'Please complete all fields and select at least 1 ticket.';
    return;
  }

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'Preparing checkout...';
  try {
    const response = await createCheckout({ name, email, phone, bundleSelections: selected });
    if (!response?.data?.url) throw new Error('No checkout URL returned.');
    window.location.href = response.data.url;
  } catch (e) {
    err.textContent = e?.message || 'Checkout failed. Please try again.';
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'Proceed to Stripe Checkout';
  }
});
