# Queue Dashboards: Prove It on the Board

A scenario that enqueues a background job (BullMQ / Bull) lands in Step 3 — a sink a QA can't reach through a
screen. **The expected proof is a bull-board screenshot showing the queue and the job**, which turns the sink into
the same filmable evidence Step 2 produces: open the board, drive it like any page, screenshot the queue and the
job. Fall back to a log/Redis capture only when the board genuinely can't be brought up.

Everything below was read off a live **bull-board 8.3.0**. Its class names are CSS-module hashed (`waiting-q0vfA9`,
`isActive-YRKOr3`) and change between builds, so assert on `role`, `title`, `href`, and text.

## Getting a board up

**When the app already mounts one** at an admin route, reach that. Which route, which port, how it's authed, and
which queue prefix it reads are project facts — look in the project's stack/local skill and `CLAUDE.md` first.

**Otherwise mount a throwaway board** against the same Redis, in a scratch dir, and tear it down in Step 7. The path
given to `setBasePath` must match the `app.use` mount path:

```bash
npm i @bull-board/api @bull-board/express bullmq express
```

```js
import express from 'express';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

const q = new Queue('<the-queue-name>', { connection: { host: '127.0.0.1', port: 6379 } });
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(q)], serverAdapter });
express().use('/admin/queues', serverAdapter.getRouter()).listen(4788);
```

## The two surfaces

**The overview, `/admin/queues`** — per-queue counts live in a stacked bar on the queue card, as ARIA values. The
status names along the top are a legend carrying no numbers, so read the bar:

```js
(()=>{const g=t=>{const e=document.querySelector(`[role=progressbar][title='${t}']`);
      return e && {n:+e.getAttribute('aria-valuenow'), of:+e.getAttribute('aria-valuemax')}};
      return {waiting:g('Waiting'), completed:g('Completed'), failed:g('Failed'), delayed:g('Delayed')}})()
```

Page text is not a substitute: `/Completed\s+\d+/` tested against `innerText` returns false over a board plainly
showing 2 completed, because the count sits inside the bar segment and the word sits in the legend.

**The queue page, `/admin/queues/queue/<name>?status=failed`** — lists the jobs, and here each status tab *is*
badged with its count. Per job it shows the id and name, the added→started→finished timing trail, the payload, and
the failure reason. **This is the page you film**: one frame carries the queue, the job, and why it ended that way.

## Confirm the queue before you trust a count

A board renders **only the queues it was registered with**, and a status with **zero jobs renders no element at
all**. Both surface as the same `null`, so a lookup that finds nothing is a **failed lookup, not a pass** — the same
law as Step 2's vacuous assert. Proven live: a second queue with a job waiting in the same Redis stayed completely
absent from the sidebar, while `Active` and `Paused` returned `null` on a queue Redis reported as `0`.

Read the queue's own presence first (`nav a` in the sidebar, or the card's title link), then its counts. When the
queue you expected is missing, the registration or the queue prefix is wrong — producer and board must share both a
Redis and a prefix — rather than the feature being broken.

## Proving a failure

**A failed job opens on its Data tab.** Click `Error` to reveal the stacktrace, which renders into a `<pre>`. The
tabs are plain buttons carrying no `role=tab` or `aria-selected`, so assert the panel's content rather than the
tab's state — the `<pre>` beginning `Error:` is the thing you came for, and it is what the frame must show.

React re-renders on the tick after the click, so **click in one batch entry and read in the next** — reading in the
same entry returns the old panel.

## When the board can't come up

Start the board host the project documents (often a separate service) and clear the registration and prefix traps
above first. **Only when the board truly can't be brought up** does a `redis-cli` / log capture become the receipt —
and then say in the row what the board was, why it wouldn't come up, and what you tried.

**Done when the row links a frame showing the queue, the job, and its outcome — the counts read from the bar, and
the queue confirmed present before those counts were believed.**
