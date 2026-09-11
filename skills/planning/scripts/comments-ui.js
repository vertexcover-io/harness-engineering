// Review comments for any page the companion server serves. Drafts are local
// until sent; sending rides the socket helper.js already holds open, and the
// agent's replies come back down it.
(function () {
  // Only the server echo retires a draft, so a send into a dropped socket
  // survives the reload the reviewer reaches for when nothing happens.
  function unacknowledgedDrafts(drafts, serverComments) {
    const known = new Set((serverComments || []).map((c) => c.id));
    return (drafts || []).filter((d) => !known.has(d.id));
  }

  function markSending(drafts, ids) {
    const sending = new Set(ids);
    return (drafts || []).map((d) => (sending.has(d.id) ? { ...d, sending: true } : d));
  }

  // Exported for tests; everything below needs a DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { unacknowledgedDrafts, markSending };
  }

  if (typeof window === 'undefined' || !document.body) return;
  if (window.__planComments) return;
  window.__planComments = true;



  // Both step shapes plan-shell.html defines. Innermost match wins.
  const BLOCKS = 'ol.impl > li, .steps .step, table tbody tr, pre, .card, .callout, .unlock, .phase, section, h2, h3, blockquote';
  // Selection is precise enough to anchor to leaf text a bubble would be noisy on.
  const SELECTION_BLOCKS = BLOCKS + ', p, li, td, dd, summary';
  // Companion mode serves every screen at "/", so the path alone would carry one
  // screen's drafts onto the next. The title is what separates them.
  const DRAFT_KEY = 'plan-comments:drafts:' + location.pathname + '|' + (document.title || '');
  const QUOTE_MAX = 180;

  const STATUS_LABEL = { sent: 'Waiting', answered: 'Answered', changed: 'Changed', declined: 'Declined' };

  let drafts = loadDrafts();
  let threads = [];
  let composerFor = null;
  let composerBox = null;
  let hovered = null;
  let dockOpen = false;

  // ---------- storage ----------

  function loadDrafts() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  // A save reloads the tab; drafts have to outlive that.
  function saveDrafts() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
    } catch (e) { /* private mode: drafts live for this page view only */ }
  }

  // ---------- anchoring ----------

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // `own` distinguishes a heading that names this element from one borrowed off
  // an ancestor — without it every step under a card gets the card's label.
  function headingFor(el) {
    if (el.matches('h2, h3')) return { text: clean(el.textContent), own: true };
    const details = el.closest('details');
    const card = el.closest('.card, .phase');
    const headEl = (card && card.querySelector('h2, h3, h4')) ||
      (details && details.querySelector('summary'));
    if (!headEl) return { text: '', own: false };
    return { text: clean(headEl.textContent), own: el.contains(headEl) };
  }

  function sectionFor(el) {
    const section = el.closest('section');
    if (!section) return '';
    const head = section.querySelector('h1, h2, h3');
    return clean(head ? head.textContent : section.id);
  }

  function anchorFor(el, quote) {
    const section = sectionFor(el);
    const heading = headingFor(el);
    // Own text is a third crumb only when the heading was borrowed; otherwise it
    // repeats it.
    const own = el === document.body ? '' : trunc(clean(el.textContent), 60);
    const useOwn = heading.own ? '' : own;
    const parts = [section, heading.text, useOwn].filter(Boolean);
    const withId = el.closest('[id]');
    return {
      id: withId ? withId.id : '',
      label: parts.join(' › ') || 'page',
      // Without a selection the element's own text stands in as the quote.
      quote: trunc(clean(quote || (heading.own ? '' : own)), QUOTE_MAX),
    };
  }

  const targetFor = (node, selector) => {
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || !el.closest) return null;
    if (el.closest('.pc-ui')) return null;
    return el.closest(selector || BLOCKS);
  };

  function scrollToAnchor(comment) {
    const el = comment.anchor.id && document.getElementById(comment.anchor.id);
    if (!el) return;
    const details = el.closest('details');
    if (details) details.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('pc-flash');
    setTimeout(() => el.classList.remove('pc-flash'), 1600);
  }

  // ---------- chrome ----------

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  const style = h('style');
  style.textContent = `
.pc-ui, .pc-ui * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.pc-bubble, .pc-chip {
  position: fixed; z-index: 2147483000; cursor: pointer; border: 1px solid var(--line, #d8d4cc);
  background: var(--surface, #fff); color: var(--ink, #1a1815); border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0,0,0,.14); font-size: 12.5px; line-height: 1; padding: 6px 9px;
}
.pc-bubble { padding: 5px 7px; font-size: 13px; }
.pc-bubble:hover, .pc-chip:hover { border-color: var(--accent, #0d5c4d); color: var(--accent, #0d5c4d); }
.pc-target { outline: 2px dashed var(--accent, #0d5c4d); outline-offset: 3px; border-radius: 4px; }
.pc-flash { animation: pc-flash 1.5s ease-out; }
@keyframes pc-flash { 0%, 60% { background: var(--amber-bg, #fdf3e0); } 100% { background: transparent; } }
.pc-marked { box-shadow: inset 3px 0 0 var(--amber, #92600a); }

.pc-composer {
  position: fixed; z-index: 2147483001; width: min(340px, calc(100vw - 24px));
  background: var(--surface, #fff); color: var(--ink, #1a1815);
  border: 1px solid var(--line, #d8d4cc); border-radius: 12px; padding: 11px;
  box-shadow: 0 8px 30px rgba(0,0,0,.22);
}
.pc-on { font-size: 11px; color: var(--ink2, #5c5850); margin-bottom: 7px; line-height: 1.35; word-break: break-word; }
.pc-composer textarea {
  width: 100%; min-height: 76px; resize: vertical; padding: 8px; font-size: 13.5px; line-height: 1.45;
  color: inherit; background: var(--bg, #faf9f7); border: 1px solid var(--line, #d8d4cc); border-radius: 8px;
}
.pc-composer textarea:focus { outline: none; border-color: var(--accent, #0d5c4d); }
.pc-row { display: flex; gap: 7px; justify-content: flex-end; margin-top: 8px; }
.pc-btn {
  cursor: pointer; font-size: 12.5px; padding: 6px 11px; border-radius: 7px;
  border: 1px solid var(--line, #d8d4cc); background: var(--surface2, #f3f1ed); color: var(--ink, #1a1815);
}
.pc-btn:hover { border-color: var(--accent, #0d5c4d); }
.pc-btn.pc-primary { background: var(--accent, #0d5c4d); border-color: var(--accent, #0d5c4d); color: #fff; }
.pc-btn.pc-primary:hover { filter: brightness(1.12); }
.pc-btn:disabled { opacity: .45; cursor: default; }

.pc-dock {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: min(348px, calc(100vw - 24px)); max-height: min(70vh, 620px); display: flex; flex-direction: column;
  background: var(--surface, #fff); color: var(--ink, #1a1815);
  border: 1px solid var(--line, #d8d4cc); border-radius: 13px; box-shadow: 0 10px 34px rgba(0,0,0,.2);
  overflow: hidden;
}
.pc-dock.pc-closed { width: auto; }
.pc-dock.pc-closed .pc-body, .pc-dock.pc-closed .pc-foot { display: none; }
.pc-head {
  display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 9px 12px;
  font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--line, #d8d4cc); background: var(--surface2, #f3f1ed);
}
.pc-dock.pc-closed .pc-head { border-bottom: none; }
.pc-count { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 99px; background: var(--accent, #0d5c4d); color: #fff; }
.pc-count.pc-zero { background: var(--chip-bg, #edeae4); color: var(--ink2, #5c5850); }
.pc-body { overflow-y: auto; padding: 5px; }
.pc-empty { padding: 16px 12px; font-size: 12.5px; color: var(--ink2, #5c5850); line-height: 1.5; }
.pc-item { border: 1px solid var(--line, #d8d4cc); border-radius: 9px; padding: 8px 9px; margin: 5px; background: var(--bg, #faf9f7); }
.pc-item .pc-where { font-size: 10.5px; color: var(--ink2, #5c5850); cursor: pointer; margin-bottom: 4px; word-break: break-word; }
.pc-item .pc-where:hover { color: var(--accent, #0d5c4d); text-decoration: underline; }
.pc-quote { font-size: 11px; color: var(--ink2, #5c5850); border-left: 2px solid var(--line, #d8d4cc); padding-left: 6px; margin-bottom: 5px; font-style: italic; }
.pc-text { font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.pc-meta { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.pc-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: 2px 6px; border-radius: 5px; background: var(--chip-bg, #edeae4); color: var(--ink2, #5c5850); }
.pc-tag.pc-draft { background: var(--amber-bg, #fdf3e0); color: var(--amber, #92600a); }
.pc-tag.pc-sending { background: var(--amber-bg, #fdf3e0); color: var(--amber, #92600a); opacity: .75; }
.pc-tag.pc-sent { background: var(--blue-bg, #e8eff6); color: var(--blue, #1f4e79); }
.pc-tag.pc-answered { background: var(--accent-soft, #e3efec); color: var(--accent, #0d5c4d); }
.pc-tag.pc-changed { background: var(--green-bg, #e5f2e9); color: var(--green, #1e6b3a); }
.pc-tag.pc-declined { background: var(--red-bg, #fbeae7); color: var(--red, #a33529); }
.pc-mini { margin-left: auto; display: flex; gap: 5px; }
.pc-mini button { cursor: pointer; font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line, #d8d4cc); background: var(--surface, #fff); color: var(--ink2, #5c5850); }
.pc-mini button:hover { color: var(--accent, #0d5c4d); border-color: var(--accent, #0d5c4d); }
.pc-reply { margin-top: 7px; padding: 7px 8px; border-radius: 7px; background: var(--accent-soft, #e3efec); font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.pc-foot { padding: 8px; border-top: 1px solid var(--line, #d8d4cc); background: var(--surface2, #f3f1ed); }
.pc-foot .pc-btn { width: 100%; }
`;
  document.head.appendChild(style);

  const bubble = h('button', 'pc-ui pc-bubble', '💬');
  bubble.title = 'Comment on this block';
  bubble.style.display = 'none';
  document.body.appendChild(bubble);

  const chip = h('button', 'pc-ui pc-chip', '💬 Comment');
  chip.style.display = 'none';
  document.body.appendChild(chip);

  const dock = h('div', 'pc-ui pc-dock pc-closed');
  const dockHead = h('div', 'pc-head');
  const dockTitle = h('span', null, 'Review comments');
  const dockCount = h('span', 'pc-count pc-zero', '0');
  dockHead.append(dockCount, dockTitle);
  const dockBody = h('div', 'pc-body');
  const dockFoot = h('div', 'pc-foot');
  const sendAll = h('button', 'pc-btn pc-primary', 'Send to Claude');
  dockFoot.appendChild(sendAll);
  dock.append(dockHead, dockBody, dockFoot);
  document.body.appendChild(dock);

  // ---------- hover + selection entry points ----------

  function placeBubble(el) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return hideBubble();
    bubble.style.display = 'block';
    bubble.style.top = Math.max(4, r.top + 2) + 'px';
    bubble.style.left = Math.min(innerWidth - 40, r.right - 32) + 'px';
  }

  function hideBubble() {
    bubble.style.display = 'none';
    if (hovered) hovered.classList.remove('pc-target');
    hovered = null;
  }

  document.addEventListener('mousemove', (e) => {
    if (composerFor) return;
    if (e.target.closest && e.target.closest('.pc-ui')) return;
    const el = targetFor(e.target);
    if (!el) return hideBubble();
    if (el === hovered) return;
    // Positioning reads layout and the outline write dirties it, so doing both
    // per pointer frame forces a full re-layout. Scroll has its own handler.
    if (hovered) hovered.classList.remove('pc-target');
    hovered = el;
    el.classList.add('pc-target');
    placeBubble(el);
  });

  addEventListener('scroll', () => {
    if (hovered && !composerFor) placeBubble(hovered);
    if (chip.style.display !== 'none') positionChipFromSelection();
  }, { passive: true });

  bubble.addEventListener('click', (e) => {
    e.stopPropagation();
    if (hovered) openComposer(hovered, '', bubble.getBoundingClientRect());
  });

  function positionChipFromSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideChip();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return hideChip();
    chip.style.display = 'block';
    chip.style.top = Math.min(innerHeight - 40, r.bottom + 6) + 'px';
    chip.style.left = Math.min(innerWidth - 120, Math.max(6, r.left)) + 'px';
  }

  const hideChip = () => { chip.style.display = 'none'; };

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest && e.target.closest('.pc-ui')) return;
    // Let the browser finish collapsing/extending the selection first.
    setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !clean(sel.toString())) return hideChip();
      positionChipFromSelection();
    }, 0);
  });

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return hideChip();
    const quote = clean(sel.toString());
    const el = targetFor(sel.anchorNode, SELECTION_BLOCKS) || document.body;
    const rect = chip.getBoundingClientRect();
    hideChip();
    sel.removeAllRanges();
    openComposer(el, quote, rect);
  });

  // ---------- composer ----------

  function openComposer(el, quote, near) {
    closeComposer();
    hideBubble();
    composerFor = anchorFor(el, quote);

    const box = h('div', 'pc-ui pc-composer');
    const on = h('div', 'pc-on');
    on.append(h('strong', null, composerFor.label));
    if (quote) on.append(document.createTextNode(' — “' + trunc(quote, 90) + '”'));
    const area = h('textarea');
    area.placeholder = 'Ask a question, or say what to change…';

    const add = h('button', 'pc-btn', 'Add');
    const send = h('button', 'pc-btn pc-primary', 'Add & send');
    const row = h('div', 'pc-row');
    row.append(add, send);
    box.append(on, area, row);
    document.body.appendChild(box);

    const top = Math.min(innerHeight - box.offsetHeight - 10, near.bottom + 8);
    box.style.top = Math.max(8, top) + 'px';
    box.style.left = Math.max(8, Math.min(innerWidth - box.offsetWidth - 8, near.left - 40)) + 'px';
    area.focus();

    const commit = (thenSend) => {
      const body = area.value.trim();
      if (!body) return closeComposer();
      const draft = { id: 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), body, anchor: composerFor };
      drafts.push(draft);
      saveDrafts();
      closeComposer();
      dockOpen = true;
      if (thenSend) submit([draft]);
      else render();
    };

    add.addEventListener('click', () => commit(false));
    send.addEventListener('click', () => commit(true));
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeComposer();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit(true);
    });
    box.addEventListener('click', (e) => e.stopPropagation());
    // Not on the anchor — that gets serialized into the draft and over the socket.
    composerBox = box;
  }

  function closeComposer() {
    if (composerBox) composerBox.remove();
    composerBox = null;
    composerFor = null;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.pc-ui')) return;
    closeComposer();
    hideChip();
  });

  addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeComposer(); hideChip(); } });

  // ---------- the wire ----------

  // Sending into a closed socket only parks the event in helper.js's in-memory
  // queue, so the draft must survive until the echo confirms it.
  function submit(batch) {
    if (!batch.length) return;
    drafts = markSending(drafts, batch.map((d) => d.id));
    saveDrafts();
    render();
    if (window.brainstorm && window.brainstorm.send) {
      window.brainstorm.send({ type: 'comments', comments: batch.map(({ sending, ...d }) => d) });
    }
  }

  addEventListener('brainstorm:message', (e) => {
    const data = e.detail;
    if (!data || data.type !== 'comments' || !Array.isArray(data.comments)) return;
    threads = data.comments;
    // The echo retires a draft whichever tab sent it.
    const before = drafts.length;
    drafts = unacknowledgedDrafts(drafts, threads);
    if (drafts.length !== before) saveDrafts();
    render();
  });

  // ---------- rendering ----------

  function itemNode(c, isDraft) {
    const item = h('div', 'pc-item');

    const where = h('div', 'pc-where', c.anchor.label || 'page');
    where.addEventListener('click', () => scrollToAnchor(c));
    item.appendChild(where);

    if (c.anchor.quote) item.appendChild(h('div', 'pc-quote', '“' + c.anchor.quote + '”'));
    item.appendChild(h('div', 'pc-text', c.body));

    const meta = h('div', 'pc-meta');
    const status = isDraft ? (c.sending ? 'sending' : 'draft') : c.status;
    const label = isDraft ? (c.sending ? 'Sending…' : 'Draft') : STATUS_LABEL[status] || status;
    meta.appendChild(h('span', 'pc-tag pc-' + status, label));

    const mini = h('div', 'pc-mini');
    if (isDraft) {
      // Stuck on "Sending…" means unacknowledged — Retry is the way back.
      const one = h('button', null, c.sending ? 'Retry' : 'Send');
      one.addEventListener('click', () => submit([c]));
      const del = h('button', null, 'Delete');
      del.addEventListener('click', () => {
        drafts = drafts.filter((d) => d.id !== c.id);
        saveDrafts();
        render();
      });
      mini.append(one, del);
    }
    meta.appendChild(mini);
    item.appendChild(meta);

    (c.replies || []).forEach((r) => item.appendChild(h('div', 'pc-reply', r.text)));
    return item;
  }

  function markAnchors(all) {
    document.querySelectorAll('.pc-marked').forEach((el) => el.classList.remove('pc-marked'));
    all.forEach((c) => {
      const el = c.anchor && c.anchor.id && document.getElementById(c.anchor.id);
      if (el) el.classList.add('pc-marked');
    });
  }

  function render() {
    const all = drafts.concat(threads);
    dock.classList.toggle('pc-closed', !dockOpen);
    dockCount.textContent = String(all.length);
    dockCount.classList.toggle('pc-zero', all.length === 0);
    dockTitle.textContent = drafts.length
      ? drafts.length + ' unsent'
      : all.length ? 'Review comments' : 'Add a comment';

    dockBody.textContent = '';
    if (!all.length) {
      dockBody.appendChild(h('div', 'pc-empty',
        'Hover any block for its 💬, or select text and click Comment. Add as many as you like, then send them together.'));
    } else {
      drafts.forEach((c) => dockBody.appendChild(itemNode(c, true)));
      threads.forEach((c) => dockBody.appendChild(itemNode(c, false)));
    }

    const unsent = drafts.filter((d) => !d.sending);
    sendAll.textContent = unsent.length > 1 ? 'Send all ' + unsent.length + ' to Claude' : 'Send to Claude';
    sendAll.disabled = unsent.length === 0;
    markAnchors(all);
  }

  dockHead.addEventListener('click', () => { dockOpen = !dockOpen; render(); });
  sendAll.addEventListener('click', () => submit(drafts.filter((d) => !d.sending)));

  // Threads arrive on the socket at connect and every reconnect; nothing to fetch.
  render();
})();
