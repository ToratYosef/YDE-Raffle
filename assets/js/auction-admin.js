import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js';
import { getFirestore, collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js';
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
const fns = getFunctions(app);

const createManual = httpsCallable(fns, 'createManualAuctionOrder');
const updateAlloc = httpsCallable(fns, 'updateAuctionAllocationAdmin');

const statsEl = document.getElementById('stats');
const searchEl = document.getElementById('search');
const ordersInfoEl = document.getElementById('ordersInfo');
const ordersEl = document.getElementById('orders');
const manualFormEl = document.getElementById('manualForm');
const manualErrEl = document.getElementById('manualErr');
const manualSubmitEl = document.getElementById('manualSubmit');
const wheelEl = document.getElementById('wheel');

const allocModalEl = document.getElementById('allocModal');
const allocModalMetaEl = document.getElementById('allocModalMeta');
const allocModalTicketsEl = document.getElementById('allocModalTickets');
const allocModalRemainingEl = document.getElementById('allocModalRemaining');
const allocModalAmountEl = document.getElementById('allocModalAmount');
const allocModalFieldsEl = document.getElementById('allocModalFields');
const allocModalErrEl = document.getElementById('allocModalErr');
const allocModalSaveEl = document.getElementById('allocModalSave');
const allocModalCloseEl = document.getElementById('allocModalClose');
const allocModalCancelEl = document.getElementById('allocModalCancel');

const packageIds = ['package1', 'package2', 'package3', 'package4', 'package5'];
let orders = [];
let activeModalOrderId = '';

manualFormEl.innerHTML = `
  <input id="mname" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Full name">
  <input id="memail" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Email">
  <input id="mphone" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Phone">
  <input id="mtickets" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" type="number" min="1" placeholder="Ticket count">
  ${packageIds.map((id, idx) => `<input id="mp${idx + 1}" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" type="number" min="0" placeholder="${id}">`).join('')}
`;

const getOrderKey = (order) => order.orderId || order.id;

const getSafeAllocations = (alloc) => {
  const clean = {};
  packageIds.forEach((id) => {
    clean[id] = Number((alloc || {})[id] || 0);
  });
  return clean;
};

const sumAllocations = (alloc) => packageIds.reduce((sum, id) => sum + Number((alloc || {})[id] || 0), 0);

const statCard = (label, value) => {
  return `
    <div class="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
      <p class="text-xs uppercase tracking-wider text-slate-400">${label}</p>
      <p class="text-2xl font-semibold text-white mt-1">${value}</p>
    </div>
  `;
};

const renderStats = () => {
  const totalOrders = orders.length;
  const totalTickets = orders.reduce((sum, o) => sum + Number(o.ticketCount || 0), 0);
  const submitted = orders.filter((o) => o.status === 'submitted').length;
  const paid = orders.filter((o) => o.status === 'paid').length;
  const totalStripe = orders.filter((o) => o.source === 'stripe').reduce((sum, o) => sum + Number(o.amountPaid || 0), 0);

  statsEl.innerHTML = [
    statCard('Orders', totalOrders),
    statCard('Tickets', totalTickets),
    statCard('Submitted', submitted),
    statCard('Paid', paid),
    statCard('Stripe Total', `$${totalStripe.toFixed(2)}`)
  ].join('');
};

const buildOrderCard = (order) => {
  return `
    <button type="button" data-edit="${getOrderKey(order)}" class="w-full text-left rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 hover:border-yellow-300/60 hover:bg-slate-900 transition-colors duration-200">
      <div class="flex items-center justify-between gap-3">
        <p class="text-lg font-semibold text-white truncate">${order.name || 'Unknown'}</p>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-1 rounded-full border border-slate-600 text-slate-300">${order.status || 'unknown'}</span>
          <span class="text-xs text-yellow-300 uppercase tracking-wider">Edit</span>
        </div>
      </div>
    </button>
  `;
};

const renderOrders = () => {
  const search = (searchEl.value || '').toLowerCase();
  const filtered = orders.filter((o) => `${o.name || ''} ${o.email || ''} ${o.phone || ''}`.toLowerCase().includes(search));

  ordersInfoEl.textContent = `${filtered.length} of ${orders.length} orders shown`;
  ordersEl.innerHTML = filtered.map(buildOrderCard).join('');
};

const getWheelEntriesForPackage = (packageId) => {
  const entries = [];
  orders.forEach((o) => {
    const count = Number((o.allocations || {})[packageId] || 0);
    const name = (o.name || '').trim() || 'Unknown';
    for (let i = 0; i < count; i += 1) {
      entries.push(name);
    }
  });
  return entries;
};

const buildWheelUrl = (packageName, entries) => {
  const logoUrl = 'https://raw.githubusercontent.com/ToratYosef/ToratYosef..github.io/refs/heads/main/assets/logos.jpeg';
  const params = new URLSearchParams({
    entries: entries.join(','),
    title: `${packageName} - YDE Auction`,
    centerImage: logoUrl
  });
  return `https://wheelofnames.com/view?${params.toString()}`;
};

const renderWheel = () => {
  wheelEl.innerHTML = window.AUCTION_DATA.auctionPackages.map((pkg, idx) => {
    const packageId = `package${idx + 1}`;
    const entries = getWheelEntriesForPackage(packageId);
    const preview = Array.from(new Set(entries)).slice(0, 3).join(', ');

    return `
      <div class="rounded-xl border border-slate-700 bg-slate-900/70 p-4" data-wheel-card="${idx}">
        <h3 class="text-xl font-semibold text-white">${pkg.name}</h3>
        <p class="text-sm text-slate-300 mt-1">Entries: ${entries.length}</p>
        <p class="text-xs text-slate-400 mt-2 min-h-5">${preview || 'No names yet'}</p>
        <button ${entries.length ? '' : 'disabled'} data-wheel-open="${idx}" class="mt-3 w-full bg-yellow-400 hover:bg-yellow-500 text-black font-semibold px-3 py-2 rounded-lg transition-colors duration-300 disabled:opacity-40 disabled:cursor-not-allowed">
          Submit To Wheel Of Names
        </button>
      </div>
    `;
  }).join('');
};

const openAllocModal = (orderId) => {
  const order = orders.find((o) => getOrderKey(o) === orderId);
  if (!order) return;

  activeModalOrderId = orderId;
  const allocations = getSafeAllocations(order.allocations);

  allocModalMetaEl.textContent = `${order.name || 'Unknown'} • ${order.email || ''} ${order.phone || ''}`;
  allocModalTicketsEl.textContent = String(Number(order.ticketCount || 0));
  allocModalAmountEl.textContent = `$${Number(order.amountPaid || 0).toFixed(2)}`;
  allocModalErrEl.textContent = '';

  allocModalFieldsEl.innerHTML = packageIds.map((id) => `
    <label class="text-xs text-slate-300">
      ${id}
      <input data-modal-p="${id}" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 p-2" type="number" min="0" value="${allocations[id]}">
    </label>
  `).join('');

  const syncRemaining = () => {
    let sum = 0;
    allocModalFieldsEl.querySelectorAll('input[data-modal-p]').forEach((input) => {
      const value = Math.max(0, Number(input.value || 0));
      sum += value;
    });
    const remaining = Number(order.ticketCount || 0) - sum;
    allocModalRemainingEl.textContent = String(remaining);
    allocModalRemainingEl.className = `font-semibold ${remaining === 0 ? 'text-emerald-300' : 'text-amber-300'}`;
  };

  allocModalFieldsEl.querySelectorAll('input[data-modal-p]').forEach((input) => {
    input.addEventListener('input', syncRemaining);
  });

  syncRemaining();
  allocModalEl.classList.remove('hidden');
  allocModalEl.classList.add('flex');
};

const closeAllocModal = () => {
  activeModalOrderId = '';
  allocModalEl.classList.add('hidden');
  allocModalEl.classList.remove('flex');
  allocModalFieldsEl.innerHTML = '';
  allocModalErrEl.textContent = '';
};

const saveAllocModal = async () => {
  if (!activeModalOrderId) return;

  const allocations = {};
  allocModalFieldsEl.querySelectorAll('input[data-modal-p]').forEach((input) => {
    allocations[input.dataset.modalP] = Number(input.value || 0);
  });

  allocModalSaveEl.disabled = true;
  allocModalSaveEl.textContent = 'Saving...';
  allocModalErrEl.textContent = '';

  try {
    await updateAlloc({ orderId: activeModalOrderId, allocations });
    await load();
    closeAllocModal();
  } catch (error) {
    allocModalErrEl.textContent = error?.message || 'Save failed';
  } finally {
    allocModalSaveEl.disabled = false;
    allocModalSaveEl.textContent = 'Save Allocations';
  }
};

const load = async () => {
  const snap = await getDocs(collection(db, 'auctionOrders'));
  orders = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((order) => order.status === 'paid' || order.status === 'submitted');

  orders.sort((a, b) => {
    const aTime = a.createdAt?.seconds || 0;
    const bTime = b.createdAt?.seconds || 0;
    return bTime - aTime;
  });

  renderStats();
  renderOrders();
  renderWheel();
};

searchEl.addEventListener('input', renderOrders);

manualSubmitEl.addEventListener('click', async () => {
  manualErrEl.textContent = '';

  const allocations = {};
  packageIds.forEach((id, idx) => {
    const input = document.getElementById(`mp${idx + 1}`);
    allocations[id] = Number(input?.value || 0);
  });

  const payload = {
    name: document.getElementById('mname').value,
    email: document.getElementById('memail').value,
    phone: document.getElementById('mphone').value,
    ticketCount: Number(document.getElementById('mtickets').value || 0),
    allocations
  };

  manualSubmitEl.disabled = true;
  manualSubmitEl.textContent = 'Creating...';
  try {
    await createManual(payload);
    await load();
    manualFormEl.querySelectorAll('input').forEach((input) => {
      input.value = '';
    });
  } catch (error) {
    manualErrEl.textContent = error?.message || 'Failed to create manual order.';
  } finally {
    manualSubmitEl.disabled = false;
    manualSubmitEl.textContent = 'Create Manual Order';
  }
});

ordersEl.addEventListener('click', (event) => {
  const editBtn = event.target.closest('button[data-edit]');
  if (!editBtn) return;
  openAllocModal(editBtn.dataset.edit);
});

allocModalCloseEl.addEventListener('click', closeAllocModal);
allocModalCancelEl.addEventListener('click', closeAllocModal);
allocModalSaveEl.addEventListener('click', saveAllocModal);

allocModalEl.addEventListener('click', (event) => {
  if (event.target === allocModalEl) closeAllocModal();
});

wheelEl.addEventListener('click', (event) => {
  const wheelBtn = event.target.closest('button[data-wheel-open]');
  if (!wheelBtn) return;

  const idx = Number(wheelBtn.dataset.wheelOpen);
  const packageId = `package${idx + 1}`;
  const packageName = window.AUCTION_DATA.auctionPackages[idx]?.name || packageId;
  const entries = getWheelEntriesForPackage(packageId);
  if (!entries.length) return;

  const url = buildWheelUrl(packageName, entries);
  window.open(url, '_blank', 'noopener');
});

load().catch((error) => {
  ordersInfoEl.textContent = error?.message || 'Failed to load auction orders.';
});
