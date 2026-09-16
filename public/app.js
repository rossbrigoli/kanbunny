// ── State ─────────────────────────────────────────
let boards = [];
let currentBoardId = null;
let cards = {};
let dragCardId = null;
let dragGhost = null;
let dropdownBoardId = null;
let mobileViewColumn = 'todo';
let mobileMenuOpen = false;
let lastCardSnapshot = ''; // for diff-based auto-refresh

const $ = (s) => document.querySelector(s);

// ── Auth (KB-AUTH-5) ──────────────────────────────
let currentUser = null;

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]) : null;
}

function isAdmin() {
  return currentUser && currentUser.role === 'admin';
}

function loginHere() {
  window.location.href = '/auth/login?next=' + encodeURIComponent(location.pathname + location.search);
}

async function initAuth() {
  const res = await fetch('/auth/me');
  if (res.status === 401) { loginHere(); return; }
  currentUser = await res.json();
  document.getElementById('authControls').style.display = 'flex';
  document.getElementById('userChip').textContent = `${currentUser.login} (${currentUser.role})`;
  if (isAdmin()) document.getElementById('adminBtn').style.display = '';
  applyRoleToUi();
}

function applyRoleToUi() {
  const display = isAdmin() ? '' : 'none';
  document.getElementById('newBoardBtn').style.display = display;
  const mobileBtn = document.getElementById('mobileNewBoardBtn');
  if (mobileBtn) mobileBtn.style.display = display;
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/auth/login';
}

// ── API helpers ───────────────────────────────────
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCookie('kb_csrf');
    if (csrf) headers['X-Kb-Csrf'] = csrf;
  }
  const res = await fetch(`/api${path}`, { ...options, headers });
  if (res.status === 401) { loginHere(); throw new Error('unauthenticated'); }
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ── Board management ──────────────────────────────
async function loadBoards() {
  boards = await api('/boards');

  const noAccess = document.getElementById('noAccess');
  if (noAccess) noAccess.style.display = boards.length === 0 ? 'flex' : 'none';

  // Restore persisted selection, or fall back to first board
  if (!currentBoardId) {
    const saved = localStorage.getItem('kanbunny_board');
    if (saved && boards.some((b) => b.id === saved)) {
      currentBoardId = saved;
    } else if (boards.length > 0) {
      currentBoardId = boards[0].id;
    }
  }

  renderBoardTabs();
  if (currentBoardId) {
    await loadCards();
  }
}

function renderBoardTabs() {
  const dots = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
  const container = $('#boardTabs');
  container.innerHTML = boards.map((b) => {
    const isActive = b.id === currentBoardId;
    return `<div class="board-tab-wrap">
      <button class="board-tab${isActive ? ' active' : ''}"
              onclick="switchBoard('${b.id}')">${escapeHtml(b.name)}</button>
      <button class="board-tab-menu" onclick="toggleBoardDropdown(event, '${b.id}')" title="Board options">${dots}</button>
    </div>`;
  }).join('');

  // Mobile sidebar board list
  const mobileList = $('#mobileBoardList');
  if (mobileList) {
    mobileList.innerHTML = boards.map((b) => {
      const isActive = b.id === currentBoardId;
      return `<button class="mobile-board-item${isActive ? ' active' : ''}" onclick="switchBoard('${b.id}')">
        <span>${escapeHtml(b.name)}</span>
      </button>`;
    }).join('');
  }

  // Mobile board label
  const label = $('#mobileBoardLabel');
  if (label) {
    const current = boards.find((b) => b.id === currentBoardId);
    label.textContent = current ? current.name : '';
  }
}

function toggleBoardDropdown(e, boardId) {
  e.stopPropagation();
  const dropdown = $('#boardDropdown');
  const btn = e.currentTarget;

  if (dropdown.classList.contains('show') && dropdownBoardId === boardId) {
    dropdown.classList.remove('show');
    dropdownBoardId = null;
    return;
  }

  dropdownBoardId = boardId;
  const rect = btn.parentElement.getBoundingClientRect();
  dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  dropdown.style.left = (rect.left + window.scrollX) + 'px';
  dropdown.classList.add('show');
}

// Handle dropdown item clicks via event delegation
$('#boardDropdown').addEventListener('click', (e) => {
  const item = e.target.closest('.dropdown-item');
  if (!item) return;
  e.stopPropagation();
  const boardId = dropdownBoardId;
  const action = item.dataset.action;
  if (action === 'rename') {
    editBoardName(boardId);
  } else if (action === 'delete') {
    deleteBoard(boardId);
  }
});

// Close dropdown on outside click
document.addEventListener('click', () => {
  const dropdown = $('#boardDropdown');
  if (dropdown && dropdown.classList.contains('show')) {
    dropdown.classList.remove('show');
    dropdownBoardId = null;
  }
});

async function switchBoard(id) {
  currentBoardId = id;
  localStorage.setItem('kanbunny_board', id);
  renderBoardTabs();
  await loadCards();
  // Close mobile sidebar after switching
  if (mobileMenuOpen) closeMobileSidebar();
}

async function createBoard() {
  const name = $('#boardName').value.trim();
  if (!name) return;
  await api('/boards', { method: 'POST', body: JSON.stringify({ name }) });
  $('#boardName').value = '';
  closeBoardModal();
  await loadBoards();
}

async function editBoardName(boardId) {
  if (!boardId) return;
  const board = boards.find((b) => b.id === boardId);
  if (!board) return;

  $('#boardDropdown').classList.remove('show');
  $('#boardModal').querySelector('.modal-header h3').textContent = 'Rename Board';

  const footer = $('#boardModal').querySelector('.modal-footer');
  footer.innerHTML = `
    <button class="btn-secondary" onclick="closeBoardModal()">Cancel</button>
    <button class="btn-primary" onclick="saveBoardName('${boardId}')">Save</button>
  `;

  $('#boardName').value = board.name;
  $('#boardModal').classList.add('active');
  setTimeout(() => $('#boardName').focus(), 100);
}

async function saveBoardName(id) {
  const name = $('#boardName').value.trim();
  if (!name) return;
  await api(`/boards/${id}`, { method: 'PUT', body: JSON.stringify({ name }) });
  closeBoardModal();
  await loadBoards();
}

async function deleteBoard(boardId) {
  if (!boardId) return;
  const board = boards.find((b) => b.id === boardId);
  if (!board) return;

  if (boards.length <= 1) {
    alert('You need at least one board.');
    $('#boardDropdown').classList.remove('show');
    return;
  }

  if (!confirm(`Delete "${board.name}" and all its cards?`)) {
    $('#boardDropdown').classList.remove('show');
    return;
  }

  await api(`/boards/${boardId}`, { method: 'DELETE' });
  $('#boardDropdown').classList.remove('show');

  if (currentBoardId === boardId) {
    currentBoardId = null;
  }
  await loadBoards();
}

// ── Card management ───────────────────────────────
async function loadCards() {
  if (!currentBoardId) return;
  const allCards = await api(`/boards/${currentBoardId}/cards`);
  cards = {};
  ['todo', 'in-progress', 'blocked', 'in-review', 'done'].forEach((col) => {
    cards[col] = allCards.filter((c) => c.column === col);
  });
  renderCards();
  // Capture snapshot after manual load so next auto-refresh only fires on real changes
  lastCardSnapshot = JSON.stringify(allCards.map(c => ({ id: c.id, column: c.column, title: c.title, priority: c.priority })));
}

// ── Auto-refresh (polling every 10s, diff-based) ──
let refreshInterval = null;

function startAutoRefresh() {
  stopAutoRefresh();
  refreshInterval = setInterval(autoRefreshCards, 10000);
}

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function autoRefreshCards() {
  if (!currentBoardId) return;
  try {
    const allCards = await api(`/boards/${currentBoardId}/cards`);
    const newSnapshot = JSON.stringify(allCards.map(c => ({ id: c.id, column: c.column, title: c.title, priority: c.priority })));
    if (newSnapshot !== lastCardSnapshot) {
      cards = {};
      ['todo', 'in-progress', 'blocked', 'in-review', 'done'].forEach((col) => {
        cards[col] = allCards.filter((c) => c.column === col);
      });
      renderCards();
      lastCardSnapshot = newSnapshot;
    }
  } catch (_) {
    // ignore transient errors; next poll will retry
  }
}

// FLIP animation state
let flipAnimations = new Map(); // cardId -> {firstRect, element}

function renderCards(animate = false) {
  ['todo', 'in-progress', 'blocked', 'in-review', 'done'].forEach((col) => {
    const container = $(`#col-${col}`);
    const countEl = $(`#count-${col}`);
    const colCards = cards[col] || [];

    // Capture first positions before re-render
    const firstPositions = new Map();
    if (animate) {
      container.querySelectorAll('.card').forEach(el => {
        firstPositions.set(el.dataset.id, el.getBoundingClientRect());
      });
    }

    countEl.textContent = colCards.length;
    container.innerHTML = colCards.map(cardCardHtml).join('');

    // Apply FLIP animation with spring-like easing
    if (animate) {
      container.querySelectorAll('.card').forEach(el => {
        const id = el.dataset.id;
        const first = firstPositions.get(id);
        const last = el.getBoundingClientRect();
        if (first) {
          const dx = first.left - last.left;
          const dy = first.top - last.top;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist > 1) {
            // Invert: start at old position
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            el.style.transition = 'none';
            
            // Play: animate to new position with spring easing
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                // Use spring-like cubic bezier for bouncy effect
                el.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
                el.style.transform = '';
                
                // Clean up inline styles after animation
                el.addEventListener('transitionend', () => {
                  el.style.transform = '';
                  el.style.transition = '';
                }, { once: true });
              });
            });
          }
        }
      });
    }
  });
  renderMobileCards();
}

function renderMobileCards() {
  const list = $('#mobileCardList');
  if (!list) return;
  const allCards = Object.values(cards).flat();
  const filtered = mobileViewColumn === 'all' ? allCards : (cards[mobileViewColumn] || []);
  if (!filtered.length) {
    list.innerHTML = '<div class="mobile-empty">No cards here</div>';
    return;
  }
  list.innerHTML = filtered.map(cardCardHtml).join('');
}

function cardCardHtml(c) {
  const created = new Date(c.created_at).toLocaleDateString();
  const assigneeHtml = c.assignee
    ? `<div class="card-assignee"><span class="assignee-avatar">${c.assignee.charAt(0).toUpperCase()}</span>${escapeHtml(c.assignee)}</div>`
    : '';
  const priorityLabel = ['','🔴 Critical','🟠 High','🔵 Medium','🟢 Low','⚪ Backlog'];
  const priorityHtml = (c.priority != null && c.priority > 0)
    ? `<span class="card-priority p${c.priority}">${priorityLabel[c.priority] || c.priority}</span>`
    : '';
  return `<div class="card" draggable="true" data-id="${c.id}"
                ondragstart="handleDragStart(event, '${c.id}')"
                ondragend="handleDragEnd(event)"
                onclick="openEditCard('${c.id}')">
    <div class="card-title">${c.ref ? `<span class="card-ref">${escapeHtml(c.ref)}</span> ` : ''}${escapeHtml(c.title)}</div>
    ${c.description ? `<div class="card-desc">${escapeHtml(c.description)}</div>` : ''}
    <div class="card-meta">
      <span>${created}</span>
      ${priorityHtml}
      ${assigneeHtml}
      <div class="card-actions">
        <button class="card-edit-btn" onclick="event.stopPropagation(); openEditCard('${c.id}')" title="Edit">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        </button>
      </div>
    </div>
  </div>`;
}

// ── Drag & Drop (Desktop) ─────────────────────────
let dragStartRect = null; // Track card position before drag
let dragPlaceholder = null; // Placeholder element during drag

function handleDragStart(e, id) {
  dragCardId = id;
  const cardEl = e.currentTarget;
  
  // Create placeholder at original position with smooth appearance
  dragPlaceholder = document.createElement('div');
  dragPlaceholder.className = 'card drag-placeholder';
  dragPlaceholder.style.height = cardEl.offsetHeight + 'px';
  cardEl.parentNode.insertBefore(dragPlaceholder, cardEl.nextSibling);
  
  // Add smooth scale-down and fade to dragging card
  cardEl.classList.add('dragging');
  cardEl.style.transform = 'scale(0.92) rotate(3deg)';
  cardEl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
  
  dragStartRect = cardEl.getBoundingClientRect();
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  
  // Create ghost card that follows cursor
  dragGhost = cardEl.cloneNode(true);
  dragGhost.className = 'card drag-ghost';
  dragGhost.style.width = cardEl.offsetWidth + 'px';
  dragGhost.style.height = cardEl.offsetHeight + 'px';
  document.body.appendChild(dragGhost);
  
  // Position ghost at cursor
  e.dataTransfer.setDragImage(dragGhost, dragGhost.offsetWidth / 2, dragGhost.offsetHeight / 2);
  
  // Remove ghost after drag starts (browser handles cursor image)
  setTimeout(() => {
    if (dragGhost && dragGhost.parentNode) {
      dragGhost.remove();
      dragGhost = null;
    }
  }, 0);
}

function handleDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  e.currentTarget.style.transform = '';
  e.currentTarget.style.boxShadow = '';
  
  // Remove placeholder with fade-out
  if (dragPlaceholder && dragPlaceholder.parentNode) {
    dragPlaceholder.style.opacity = '0';
    dragPlaceholder.style.transform = 'scale(0.95)';
    setTimeout(() => {
      if (dragPlaceholder && dragPlaceholder.parentNode) {
        dragPlaceholder.remove();
        dragPlaceholder = null;
      }
    }, 200);
  }
  
  // Clean up all drag states
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  document.querySelectorAll('.drag-over-column').forEach((el) => el.classList.remove('drag-over-column'));
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  
  dragCardId = null;
  dragStartRect = null;
  dragGhost = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const columnBody = e.currentTarget;
  const column = columnBody.closest('.column');
  
  columnBody.classList.add('drag-over');
  if (column) column.classList.add('drag-over-column');
  
  // Find the card we're hovering over (exclude placeholders)
  const targetCard = e.target.closest('.card:not(.drag-placeholder)');
  
  // Remove existing indicator
  const oldIndicator = columnBody.querySelector('.drop-indicator');
  if (oldIndicator) oldIndicator.remove();
  
  if (targetCard && targetCard.dataset.id !== dragCardId) {
    // Create/position drop indicator with smooth animation
    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    
    const rect = targetCard.getBoundingClientRect();
    const colRect = columnBody.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    
    // Position above or below the target card based on hover position
    const yPos = e.clientY < midY 
      ? rect.top - colRect.top - 2 
      : rect.bottom - colRect.top + 2;
    
    indicator.style.top = yPos + 'px';
    indicator.style.opacity = '0';
    indicator.style.transform = 'scaleX(0.8)';
    columnBody.appendChild(indicator);
    
    // Animate in
    requestAnimationFrame(() => {
      indicator.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      indicator.style.opacity = '1';
      indicator.style.transform = 'scaleX(1)';
    });
  }
}

/** Find a card by ID across all columns. */
function findCard(id) {
  for (const col of Object.values(cards)) {
    const found = col.find((c) => c.id === id);
    if (found) return found;
  }
  return null;
}

/** Update the snapshot so auto-refresh doesn't undo optimistic changes. */
function updateCardSnapshot() {
  const all = Object.values(cards).flat();
  lastCardSnapshot = JSON.stringify(all.map(c => ({ id: c.id, column: c.column, title: c.title, priority: c.priority })));
}

/**
 * Optimistically move a card in local state, then sync with the server.
 * - Cross-column: PATCH column, then recompute priorities.
 * - Same-column reorder: PUT /move to update position (and priority).
 */
async function handleDrop(e, targetColumn) {
  e.preventDefault();
  const columnBody = e.currentTarget;
  columnBody.classList.remove('drag-over');
  const column = columnBody.closest('.column');
  if (column) column.classList.remove('drag-over-column');
  
  // Remove drop indicator
  const indicator = columnBody.querySelector('.drop-indicator');
  if (indicator) indicator.remove();
  
  if (!dragCardId) return;

  const droppedOn = e.target.closest('.card:not(.drag-placeholder)');
  let afterCardId = null;
  if (droppedOn && droppedOn.dataset.id !== dragCardId) {
    afterCardId = droppedOn.dataset.id;
  }

  // --- Optimistic frontend update ---
  const card = findCard(dragCardId);
  if (!card) return;
  const sourceColumn = card.column;

  if (sourceColumn !== targetColumn) {
    // Cross-column: remove from source, append to target
    cards[sourceColumn] = cards[sourceColumn].filter((c) => c.id !== dragCardId);
    card.column = targetColumn;
    cards[targetColumn].push(card);
  } else if (afterCardId) {
    // Same-column reorder: move card to position after target
    const colCards = cards[targetColumn];
    const afterIdx = colCards.findIndex((c) => c.id === afterCardId);
    const cardIdx = colCards.findIndex((c) => c.id === dragCardId);
    if (afterIdx !== -1 && cardIdx !== -1) {
      const [removed] = colCards.splice(cardIdx, 1);
      const newIdx = cardIdx < afterIdx ? afterIdx : afterIdx + 1;
      colCards.splice(newIdx, 0, removed);
    }
  }
  renderCards(true); // Enable FLIP animation
  updateCardSnapshot();
  
  // Add landing animation to the dropped card with enhanced effects
  const droppedCardEl = $(`[data-id="${dragCardId}"]`);
  if (droppedCardEl) {
    droppedCardEl.classList.add('card-landed');
    droppedCardEl.addEventListener('animationend', () => {
      droppedCardEl.classList.remove('card-landed');
    }, { once: true });
    
    // Add subtle scale bounce after FLIP completes
    setTimeout(() => {
      droppedCardEl.style.transform = 'scale(1.02)';
      droppedCardEl.style.transition = 'transform 0.15s ease-out';
      setTimeout(() => {
        droppedCardEl.style.transform = 'scale(1)';
        setTimeout(() => {
          droppedCardEl.style.transform = '';
          droppedCardEl.style.transition = '';
        }, 150);
      }, 150);
    }, 100);
  }

  // --- Sync with server ---
  try {
    if (sourceColumn !== targetColumn) {
      await api(`/cards/${dragCardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ column: targetColumn }),
      });
      // Recompute priorities for all columns on this board
      await api(`/boards/${currentBoardId}/cards/priority/recompute`, {
        method: 'POST',
        body: JSON.stringify({}),
      }).catch(() => {});
    } else if (afterCardId) {
      await api(`/cards/${dragCardId}/move`, {
        method: 'PUT',
        body: JSON.stringify({ afterCardId }),
      });
    }
  } catch (err) {
    // On error, refetch to restore correct state
    await loadCards();
    console.error('Drop sync failed:', err);
  }
}

// ── Touch Drag & Drop (Mobile) ────────────────────
let mobileDragCardId = null;
let mobileDragGhost = null;
let mobileDragStartY = 0;
let mobileDragStartX = 0;
let mobileDragThreshold = 10; // px before we consider it a drag
let mobileDragActive = false;
let mobileDragIndicator = null;
let mobileDragPlaceholder = null;

function initMobileDrag() {
  document.addEventListener('touchstart', onMobileDragStart, { passive: false });
  document.addEventListener('touchmove', onMobileDragMove, { passive: false });
  document.addEventListener('touchend', onMobileDragEnd);
}

function onMobileDragStart(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl || cardEl.closest('#cardModal') || cardEl.closest('#boardModal')) return;

  mobileDragCardId = cardEl.dataset.id;
  mobileDragStartY = e.touches[0].clientY;
  mobileDragStartX = e.touches[0].clientX;
  mobileDragActive = false;
}

function onMobileDragMove(e) {
  if (!mobileDragCardId) return;

  const touch = e.touches[0];
  const dy = Math.abs(touch.clientY - mobileDragStartY);
  const dx = Math.abs(touch.clientX - mobileDragStartX);

  if (!mobileDragActive && (dy > mobileDragThreshold || dx > mobileDragThreshold)) {
    mobileDragActive = true;
    e.preventDefault();

    // Create placeholder at original position
    const card = document.querySelector(`[data-id="${mobileDragCardId}"]`);
    if (card) {
      card.classList.add('mobile-dragging');
      
      // Create placeholder
      mobileDragPlaceholder = document.createElement('div');
      mobileDragPlaceholder.className = 'card drag-placeholder';
      mobileDragPlaceholder.style.height = card.offsetHeight + 'px';
      card.parentNode.insertBefore(mobileDragPlaceholder, card.nextSibling);
      
      // Create ghost element with enhanced styling
      mobileDragGhost = card.cloneNode(true);
      mobileDragGhost.className = 'mobile-drag-ghost';
      mobileDragGhost.style.width = card.offsetWidth + 'px';
      document.body.appendChild(mobileDragGhost);
    }
  }

  if (mobileDragActive) {
    e.preventDefault();

    // Move ghost with smooth follow
    if (mobileDragGhost) {
      mobileDragGhost.style.left = (touch.clientX - 60) + 'px';
      mobileDragGhost.style.top = (touch.clientY - 30) + 'px';
    }

    // Find drop target (exclude placeholders and ghost)
    const targetCard = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.card:not(.drag-placeholder):not(.mobile-drag-ghost)');
    removeDragIndicator();

    if (targetCard && targetCard.dataset.id !== mobileDragCardId) {
      const rect = targetCard.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      mobileDragIndicator = document.createElement('div');
      mobileDragIndicator.className = 'mobile-drag-indicator';

      if (touch.clientY < midY) {
        targetCard.parentNode.insertBefore(mobileDragIndicator, targetCard);
      } else {
        targetCard.parentNode.insertBefore(mobileDragIndicator, targetCard.nextSibling);
      }
    }
  }
}

function onMobileDragEnd(e) {
  if (!mobileDragCardId) return;

  if (mobileDragActive) {
    const touch = e.changedTouches[0];
    const targetCard = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.card:not(.drag-placeholder)');

    if (targetCard && targetCard.dataset.id !== mobileDragCardId) {
      const rect = targetCard.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertAfter = touch.clientY >= midY;
      const targetCardData = findCard(targetCard.dataset.id);
      const draggedCardData = findCard(mobileDragCardId);

      if (targetCardData && draggedCardData) {
        const targetColumn = targetCardData.column;
        const sourceColumn = draggedCardData.column;

        // --- Optimistic frontend update ---
        if (sourceColumn !== targetColumn) {
          // Cross-column move
          cards[sourceColumn] = cards[sourceColumn].filter((c) => c.id !== mobileDragCardId);
          draggedCardData.column = targetColumn;
          if (insertAfter) {
            const afterIdx = cards[targetColumn].findIndex((c) => c.id === targetCard.dataset.id);
            cards[targetColumn].splice(afterIdx + 1, 0, draggedCardData);
          } else {
            const beforeIdx = cards[targetColumn].findIndex((c) => c.id === targetCard.dataset.id);
            cards[targetColumn].splice(beforeIdx, 0, draggedCardData);
          }
        } else {
          // Same-column reorder
          const colCards = cards[targetColumn];
          const afterIdx = colCards.findIndex((c) => c.id === targetCard.dataset.id);
          const cardIdx = colCards.findIndex((c) => c.id === mobileDragCardId);
          if (afterIdx !== -1 && cardIdx !== -1) {
            const [removed] = colCards.splice(cardIdx, 1);
            const newIdx = insertAfter
              ? (cardIdx < afterIdx ? afterIdx : afterIdx + 1)
              : (cardIdx < afterIdx ? afterIdx - 1 : afterIdx);
            colCards.splice(Math.max(0, newIdx), 0, removed);
          }
        }
        renderCards(true); // Enable FLIP animation
        updateCardSnapshot();
        
        // Add landing animation
        const landedCard = $(`[data-id="${mobileDragCardId}"]`);
        if (landedCard) {
          landedCard.classList.add('card-landed');
          landedCard.addEventListener('animationend', () => {
            landedCard.classList.remove('card-landed');
          }, { once: true });
        }

        // --- Sync with server ---
        (async () => {
          try {
            if (sourceColumn !== targetColumn) {
              await api(`/cards/${mobileDragCardId}`, {
                method: 'PATCH',
                body: JSON.stringify({ column: targetColumn }),
              });
              await api(`/boards/${currentBoardId}/cards/priority/recompute`, {
                method: 'POST',
                body: JSON.stringify({}),
              }).catch(() => {});
            } else {
              const afterCardId = insertAfter ? targetCard.dataset.id : null;
              if (!afterCardId) {
                const prev = targetCard.previousElementSibling;
                if (prev && prev.classList.contains('card')) {
                  await api(`/cards/${mobileDragCardId}/move`, {
                    method: 'PUT',
                    body: JSON.stringify({ afterCardId: prev.dataset.id }),
                  });
                }
              } else {
                await api(`/cards/${mobileDragCardId}/move`, {
                  method: 'PUT',
                  body: JSON.stringify({ afterCardId }),
                });
              }
            }
          } catch (err) {
            await loadCards();
            console.error('Mobile drop sync failed:', err);
          }
        })();
      }
    }
  }

  // Cleanup
  removeDragIndicator();
  if (mobileDragGhost) {
    mobileDragGhost.remove();
    mobileDragGhost = null;
  }
  if (mobileDragPlaceholder) {
    mobileDragPlaceholder.remove();
    mobileDragPlaceholder = null;
  }

  const cardEl = document.querySelector(`[data-id="${mobileDragCardId}"]`);
  if (cardEl) cardEl.classList.remove('mobile-dragging');

  mobileDragCardId = null;
  mobileDragActive = false;
}

function removeDragIndicator() {
  if (mobileDragIndicator) {
    mobileDragIndicator.remove();
    mobileDragIndicator = null;
  }
}

// ── Card Modal ────────────────────────────────────
let editingColumn = 'todo';

function showAddCard(column) {
  editingColumn = column;
  $('#modalTitle').textContent = 'New Card';
  $('#cardId').value = '';
  $('#cardTitle').value = '';
  $('#cardDescription').value = '';
  $('#cardAssignee').value = '';
  $('#cardPriority').value = '';
  $('#deleteCardBtn').style.display = 'none';
  $('#cardModal').classList.add('active');
  setTimeout(() => $('#cardTitle').focus(), 100);
}

function openEditCard(id) {
  const allCards = Object.values(cards).flat();
  const card = allCards.find((c) => c.id === id);
  if (!card) return;

  editingColumn = card.column;
  $('#modalTitle').textContent = 'Edit Card';
  $('#cardId').value = card.id;
  $('#cardTitle').value = card.title;
  $('#cardDescription').value = card.description || '';
  $('#cardAssignee').value = card.assignee || '';
  $('#cardPriority').value = card.priority != null ? card.priority : '';
  $('#deleteCardBtn').style.display = 'block';
  $('#cardModal').classList.add('active');
}

function closeModal() {
  $('#cardModal').classList.remove('active');
}

async function saveCard() {
  const id = $('#cardId').value;
  const title = $('#cardTitle').value.trim();
  const description = $('#cardDescription').value.trim();
  const assignee = $('#cardAssignee').value.trim();
  const priorityVal = $('#cardPriority').value;
  const priority = priorityVal ? parseInt(priorityVal, 10) : null;

  if (!title) return;

  if (id) {
    await api(`/cards/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, description, assignee, priority }),
    });
  } else {
    await api(`/boards/${currentBoardId}/cards`, {
      method: 'POST',
      body: JSON.stringify({ title, description, column: editingColumn, assignee, priority }),
    });
  }

  closeModal();
  await loadCards();
}

async function deleteCard() {
  const id = $('#cardId').value;
  if (!id) return;
  if (!confirm('Delete this card?')) return;

  await api(`/cards/${id}`, { method: 'DELETE' });
  closeModal();
  await loadCards();
}

// ── Board Modal ───────────────────────────────────
$('#newBoardBtn').addEventListener('click', () => {
  $('#boardModal').querySelector('.modal-header h3').textContent = 'New Board';
  const footer = $('#boardModal').querySelector('.modal-footer');
  footer.innerHTML = `
    <button class="btn-secondary" onclick="closeBoardModal()">Cancel</button>
    <button class="btn-primary" onclick="createBoard()">Create</button>
  `;
  $('#boardName').value = '';
  $('#boardModal').classList.add('active');
  setTimeout(() => $('#boardName').focus(), 100);
});

function closeBoardModal() {
  $('#boardModal').classList.remove('active');
}

$('#boardName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const footer = $('#boardModal').querySelector('.modal-footer');
    const saveBtn = footer.querySelector('[onclick^="saveBoardName"]');
    if (saveBtn) saveBtn.click();
    else createBoard();
  }
});

$('#cardTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveCard();
});

// Close board modal on overlay click; card modal only closes via Cancel / ✕ / Escape
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && overlay.id !== 'cardModal') {
      overlay.classList.remove('active');
    }
  });
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeBoardModal();
    const dropdown = $('#boardDropdown');
    if (dropdown) dropdown.classList.remove('show');
  }
});

// ── Card Modal Resize ──────────────────────────────
let isResizing = false;
let resizeStartX, resizeStartY, resizeStartW, resizeStartH, resizeMode = 'both';

function initCardModalResize() {
  const modal = document.querySelector('#cardModal .modal');

  // Right-edge handle — width only
  const rightHandle = document.createElement('div');
  rightHandle.className = 'modal-resize-right';
  rightHandle.addEventListener('mousedown', (e) => startResize(e, 'width'));
  rightHandle.addEventListener('touchstart', (e) => startResizeTouch(e, 'width'), { passive: false });
  modal.appendChild(rightHandle);

  // Corner handle — width + height
  const cornerHandle = document.createElement('div');
  cornerHandle.className = 'modal-resize-handle';
  cornerHandle.addEventListener('mousedown', (e) => startResize(e, 'both'));
  cornerHandle.addEventListener('touchstart', (e) => startResizeTouch(e, 'both'), { passive: false });
  cornerHandle.addEventListener('dblclick', resetModalSize);
  modal.appendChild(cornerHandle);

  // Restore saved size
  const saved = localStorage.getItem('kanbunny_card_modal_size');
  if (saved) {
    try {
      const { width, height } = JSON.parse(saved);
      modal.style.width = width;
      modal.style.height = height;
      modal.style.maxWidth = 'none';
    } catch (_) { /* ignore */ }
  }
}

function startResize(e, mode) {
  e.preventDefault();
  // stopPropagation prevents the subsequent click event (fired after mouseup)
  // from bubbling to the overlay and triggering "close on outside click".
  e.stopPropagation(true);
  isResizing = true;
  resizeMode = mode;
  const modal = document.querySelector('#cardModal .modal');
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  resizeStartW = modal.offsetWidth;
  resizeStartH = modal.offsetHeight;

  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.userSelect = 'none';
}

function startResizeTouch(e, mode) {
  e.preventDefault();
  const t = e.touches[0];
  startResize({ clientX: t.clientX, clientY: t.clientY, preventDefault() {}, stopPropagation() {} }, mode);
  document.addEventListener('touchmove', onResizeTouch, { passive: false });
  document.addEventListener('touchend', stopResizeTouch);
}

function onResize(e) {
  if (!isResizing) return;
  const modal = document.querySelector('#cardModal .modal');
  const dx = e.clientX - resizeStartX;
  const dy = e.clientY - resizeStartY;

  const newW = Math.max(320, Math.min(window.innerWidth * 0.95, resizeStartW + dx));
  modal.style.width = newW + 'px';
  modal.style.maxWidth = 'none';

  if (resizeMode === 'both') {
    const newH = Math.max(200, Math.min(window.innerHeight * 0.9, resizeStartH + dy));
    modal.style.height = newH + 'px';
  }
}

function onResizeTouch(e) {
  if (!isResizing) return;
  e.preventDefault();
  const t = e.touches[0];
  onResize({ clientX: t.clientX, clientY: t.clientY });
}

function stopResize() {
  if (!isResizing) return;
  finalizeResize();
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.userSelect = '';
}

function stopResizeTouch() {
  if (!isResizing) return;
  finalizeResize();
  document.removeEventListener('touchmove', onResizeTouch);
  document.removeEventListener('touchend', stopResizeTouch);
}

function finalizeResize() {
  isResizing = false;
  const modal = document.querySelector('#cardModal .modal');
  localStorage.setItem('kanbunny_card_modal_size', JSON.stringify({
    width: modal.style.width,
    height: modal.style.height
  }));
}

function resetModalSize() {
  const modal = document.querySelector('#cardModal .modal');
  modal.style.width = '';
  modal.style.height = '';
  modal.style.maxWidth = '';
  localStorage.removeItem('kanbunny_card_modal_size');
}

// ── Utilities ─────────────────────────────────────
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ── Mobile hamburger ─────────────────────────────
function openMobileSidebar() {
  mobileMenuOpen = true;
  $('#hamburgerBtn').classList.add('open');
  $('#mobileSidebar').classList.add('show');
  $('#mobileSidebarOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeMobileSidebar() {
  mobileMenuOpen = false;
  $('#hamburgerBtn').classList.remove('open');
  $('#mobileSidebar').classList.remove('show');
  $('#mobileSidebarOverlay').classList.remove('show');
  document.body.style.overflow = '';
}

$('#hamburgerBtn').addEventListener('click', () => {
  if (mobileMenuOpen) closeMobileSidebar();
  else openMobileSidebar();
});

$('#mobileSidebarClose').addEventListener('click', closeMobileSidebar);
$('#mobileSidebarOverlay').addEventListener('click', closeMobileSidebar);

// ── Mobile new board button ──────────────────────
$('#mobileNewBoardBtn').addEventListener('click', () => {
  closeMobileSidebar();
  $('#boardModal').querySelector('.modal-header h3').textContent = 'New Board';
  const footer = $('#boardModal').querySelector('.modal-footer');
  footer.innerHTML = `
    <button class="btn-secondary" onclick="closeBoardModal()">Cancel</button>
    <button class="btn-primary" onclick="createBoard()">Create</button>
  `;
  $('#boardName').value = '';
  $('#boardModal').classList.add('active');
  setTimeout(() => $('#boardName').focus(), 100);
});

// ── Mobile column selector ───────────────────────
$('#mobileColSelector').addEventListener('click', (e) => {
  const btn = e.target.closest('.mobile-col-btn');
  if (!btn) return;
  mobileViewColumn = btn.dataset.col;
  $('#mobileColSelector').querySelectorAll('.mobile-col-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderMobileCards();
});

// ── Mobile swipe navigation ─────────────────────
let touchStartX = 0;
let touchStartY = 0;
const columns = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];

document.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].screenX;
  touchStartY = e.changedTouches[0].screenY;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].screenX - touchStartX;
  const dy = e.changedTouches[0].screenY - touchStartY;
  // Only horizontal swipes (more horizontal than vertical, and >50px)
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;

  const currentIdx = columns.indexOf(mobileViewColumn);
  if (currentIdx === -1) return;

  if (dx > 0 && currentIdx > 0) {
    // Swipe left → next column
    mobileViewColumn = columns[currentIdx - 1];
  } else if (dx < 0 && currentIdx < columns.length - 1) {
    // Swipe right → previous column
    mobileViewColumn = columns[currentIdx + 1];
  } else {
    return;
  }

  $('#mobileColSelector').querySelectorAll('.mobile-col-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.col === mobileViewColumn);
  });
  renderMobileCards();
});

// ── Admin page (KB-AUTH-5) ────────────────────────
let adminUsers = [];

async function openAdmin() {
  if (!isAdmin()) return;
  document.getElementById('adminModal').style.display = 'flex';
  await loadAdminData();
}

function closeAdminModal() {
  document.getElementById('adminModal').style.display = 'none';
  document.getElementById('tokenReveal').style.display = 'none';
}

async function loadAdminData() {
  adminUsers = await api('/admin/users');
  const board = boards.find((b) => b.id === currentBoardId);
  document.getElementById('adminBoardName').textContent = board ? board.name : '(no board selected)';

  // Users table with role selects
  const tbody = document.querySelector('#adminUsersTable tbody');
  tbody.innerHTML = adminUsers.map((u) => `
    <tr>
      <td>${escapeHtml(u.login)}</td>
      <td>
        <select onchange="adminSetRole('${u.id}', this.value)" ${u.id === currentUser.id ? 'disabled' : ''}>
          ${['admin', 'user', 'agent'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </td>
    </tr>`).join('');

  // Board grants
  if (board) {
    const members = await api(`/admin/boards/${board.id}/members`);
    const memberIds = new Set(members.map((m) => m.id));
    document.getElementById('adminGrants').innerHTML = members.length
      ? members.map((m) => `
          <span class="grant-chip">
            ${escapeHtml(m.login)}
            <button onclick="revokeAccess('${board.id}','${m.id}')" title="Revoke">&times;</button>
          </span>`).join('')
      : '<em>No direct grants — admins see all boards.</em>';
    const grantSel = document.getElementById('grantUserSelect');
    grantSel.innerHTML = adminUsers
      .filter((u) => !memberIds.has(u.id))
      .map((u) => `<option value="${u.id}">${escapeHtml(u.login)}</option>`).join('');
  } else {
    document.getElementById('adminGrants').innerHTML = '';
    document.getElementById('grantUserSelect').innerHTML = '';
  }

  // Tokens
  const tokens = await api('/admin/tokens');
  const tt = document.querySelector('#adminTokensTable tbody');
  tt.innerHTML = tokens.map((t) => `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.owner_login)}</td>
      <td>${t.last_used_at || 'never'}</td>
      <td><button class="btn-danger-sm" onclick="revokeToken('${t.id}')">Revoke</button></td>
    </tr>`).join('') || '<tr><td colspan="4"><em>No tokens yet.</em></td></tr>';
  const ownerSel = document.getElementById('tokenOwnerSelect');
  ownerSel.innerHTML = adminUsers.map((u) => `<option value="${u.id}">${escapeHtml(u.login)} (${u.role})</option>`).join('');
}

async function adminSetRole(userId, role) {
  try {
    await api(`/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    await loadAdminData();
  } catch (e) {
    alert('Role change failed: ' + e.message);
    await loadAdminData();
  }
}

async function grantAccess() {
  const board = boards.find((b) => b.id === currentBoardId);
  if (!board) return alert('Select a board first');
  const userId = document.getElementById('grantUserSelect').value;
  if (!userId) return;
  await api(`/admin/boards/${board.id}/members`, { method: 'POST', body: JSON.stringify({ userId }) });
  await loadAdminData();
}

async function revokeAccess(boardId, userId) {
  await api(`/admin/boards/${boardId}/members/${userId}`, { method: 'DELETE' });
  await loadAdminData();
}

async function createToken() {
  const name = document.getElementById('tokenName').value.trim();
  const ownerId = document.getElementById('tokenOwnerSelect').value;
  if (!name) return alert('Token name required');
  const res = await api('/admin/tokens', { method: 'POST', body: JSON.stringify({ name, ownerId }) });
  document.getElementById('tokenPlaintext').textContent = res.token;
  document.getElementById('tokenReveal').style.display = '';
  document.getElementById('tokenName').value = '';
  await loadAdminData();
}

function copyToken() {
  navigator.clipboard.writeText(document.getElementById('tokenPlaintext').textContent);
}

async function revokeToken(id) {
  if (!confirm('Revoke this token? Anything using it stops immediately.')) return;
  await api(`/admin/tokens/${id}`, { method: 'DELETE' });
  await loadAdminData();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Init ──────────────────────────────────────────
async function init() {
  await initAuth();
  await loadBoards();
  initCardModalResize();
  initMobileDrag();
  startAutoRefresh();
}
init();