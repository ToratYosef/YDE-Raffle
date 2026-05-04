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

const packageIds = ['package1', 'package2', 'package3', 'package4', 'package5'];
let orders = [];

manualFormEl.innerHTML = `
  <input id="mname" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Full name">
  <input id="memail" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Email">
  <input id="mphone" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Phone">
  <input id="mtickets" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" type="number" min="1" placeholder="Ticket count">
  <input id="mnote" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Note">
  ${packageIds.map((id, idx) => `<input id="mp${idx + 1}" class="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" type="number" min="0" placeholder="${id}">`).join('')}
`;

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
  const pending = orders.filter((o) => o.status === 'pending' || o.status === 'paid').length;
  const totalStripe = orders.filter((o) => o.source === 'stripe').reduce((sum, o) => sum + Number(o.amountPaid || 0), 0);

  statsEl.innerHTML = [
    statCard('Orders', totalOrders),
    statCard('Tickets', totalTickets),
    statCard('Submitted', submitted),
    statCard('Pending', pending),
    statCard('Stripe Total', `$${totalStripe.toFixed(2)}`)
  ].join('');
};

const buildOrderCard = (order) => {
  const allocations = getSafeAllocations(order.allocations);
  const used = sumAllocations(allocations);
  const remaining = Number(order.ticketCount || 0) - used;

  return `
    <div class="rounded-xl border border-slate-700 bg-slate-900/70 p-4" data-order-card="${order.orderId || order.id}">
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="text-lg font-semibold text-white">${order.name || 'Unknown'}</p>
          <p class="text-xs text-slate-400 mt-1">${order.email || ''} ${order.phone || ''}</p>
        </div>
        <span class="text-xs px-2 py-1 rounded-full border border-slate-600 text-slate-300">${order.status || 'unknown'} / ${order.source || 'unknown'}</span>
      </div>

      <div class="mt-3 text-sm text-slate-200">
        <p>Tickets: <span class="font-semibold">${Number(order.ticketCount || 0)}</span> | Remaining: <span class="font-semibold ${remaining === 0 ? 'text-emerald-300' : 'text-amber-300'}">${remaining}</span></p>
        <p>Amount Paid: <span class="font-semibold">$${Number(order.amountPaid || 0).toFixed(2)}</span></p>
      </div>

      <div class="mt-3 grid grid-cols-2 gap-2">
        ${packageIds.map((id) => `
          <label class="text-xs text-slate-300">
            ${id}
            <input data-order="${order.orderId || order.id}" data-p="${id}" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 p-2" type="number" min="0" value="${allocations[id]}">
          </label>
        `).join('')}
      </div>

      <button data-save="${order.orderId || order.id}" class="mt-3 w-full bg-yellow-400 hover:bg-yellow-500 text-black font-semibold px-3 py-2 rounded-lg transition-colors duration-300">Save Allocations</button>
    </div>
  `;
};

const renderOrders = () => {
  const search = (searchEl.value || '').toLowerCase();
  const filtered = orders.filter((o) => `${o.name || ''} ${o.email || ''} ${o.phone || ''}`.toLowerCase().includes(search));

  ordersInfoEl.textContent = `${filtered.length} of ${orders.length} orders shown`;
  ordersEl.innerHTML = filtered.map(buildOrderCard).join('');
};

const toCsvCell = (value) => {
  const v = String(value ?? '');
  return `"${v.replace(/"/g, '""')}"`;
};

const buildPackageRows = (packageIndex) => {
  const packageId = `package${packageIndex + 1}`;
  const packageName = window.AUCTION_DATA.auctionPackages[packageIndex]?.name || packageId;
  const rows = [];

  orders.forEach((o) => {
    const count = Number((o.allocations || {})[packageId] || 0);
    for (let i = 1; i <= count; i += 1) {
      rows.push({
        name: o.name || '',
        email: o.email || '',
        phone: o.phone || '',
        package: packageName,
        ticketNumber: i,
        orderId: o.orderId || o.id
      });
    }
  });

  return { packageId, packageName, rows };
};

const renderWheel = () => {
  wheelEl.innerHTML = window.AUCTION_DATA.auctionPackages.map((pkg, idx) => {
    const { rows } = buildPackageRows(idx);
    const names = rows.map((r) => r.name).join('\n');

    return `
      <div class="rounded-xl border border-slate-700 bg-slate-900/70 p-4" data-wheel-card="${idx}">
        <h3 class="text-xl font-semibold text-white">${pkg.name}</h3>
        <p class="text-sm text-slate-300 mt-1">Entries: ${rows.length}</p>
        <textarea readonly class="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm" rows="7">${names}</textarea>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <button data-copy="${idx}" class="bg-yellow-400 hover:bg-yellow-500 text-black font-semibold px-3 py-2 rounded-lg transition-colors duration-300">Copy Names</button>
          <button data-download="${idx}" class="bg-slate-800 hover:bg-slate-700 text-white font-semibold px-3 py-2 rounded-lg border border-slate-600 transition-colors duration-300">Download CSV</button>
        </div>
      </div>
    `;
  }).join('');
};

const load = async () => {
  const snap = await getDocs(collection(db, 'auctionOrders'));
  orders = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
    note: document.getElementById('mnote').value,
    allocations
  };

  manualSubmitEl.disabled = true;
  manualSubmitEl.textContent = 'Creating...';
  try {
    await createManual(payload);
    await load();
    manualFormEl.querySelectorAll('input').forEach((input) => {
      if (input.id === 'mnote') {
        input.value = '';
      } else if (input.type === 'number') {
        input.value = '';
      } else {
        input.value = '';
      }
    });
  } catch (error) {
    manualErrEl.textContent = error?.message || 'Failed to create manual order.';
  } finally {
    manualSubmitEl.disabled = false;
    manualSubmitEl.textContent = 'Create Manual Order';
  }
});

ordersEl.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-save]');
  if (!btn) return;

  const orderId = btn.dataset.save;
  const card = btn.closest(`[data-order-card="${orderId}"]`);
  if (!card) return;

  const allocations = {};
  card.querySelectorAll('input[data-p]').forEach((input) => {
    allocations[input.dataset.p] = Number(input.value || 0);
  });

  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await updateAlloc({ orderId, allocations });
    await load();
  } catch (error) {
    btn.textContent = error?.message || 'Save failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Allocations';
  }
});

wheelEl.addEventListener('click', async (event) => {
  const copyBtn = event.target.closest('button[data-copy]');
  const downloadBtn = event.target.closest('button[data-download]');

  if (copyBtn) {
    const idx = Number(copyBtn.dataset.copy);
    const { rows } = buildPackageRows(idx);
    const names = rows.map((r) => r.name).join('\n');
    await navigator.clipboard.writeText(names);
    copyBtn.textContent = 'Copied';
    setTimeout(() => {
      copyBtn.textContent = 'Copy Names';
    }, 900);
  }

  if (downloadBtn) {
    const idx = Number(downloadBtn.dataset.download);
    const { packageId, rows } = buildPackageRows(idx);

    const header = ['name', 'email', 'phone', 'package', 'ticketNumber', 'orderId'];
    const lines = [header.join(',')];
    rows.forEach((row) => {
      lines.push([
        toCsvCell(row.name),
        toCsvCell(row.email),
        toCsvCell(row.phone),
        toCsvCell(row.package),
        toCsvCell(row.ticketNumber),
        toCsvCell(row.orderId)
      ].join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${packageId}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
});

load().catch((error) => {
  ordersInfoEl.textContent = error?.message || 'Failed to load auction orders.';
});
