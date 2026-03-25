# Task Manager Implementation Plan

## Goal
Build an async task manager that queues, executes, and tracks tasks with priority ordering and event-driven notifications.

## Acceptance Criteria
1. Tasks have unique IDs, titles, statuses (pending/running/done/failed), and priorities
2. `runTask` must properly await the async handler and capture results or errors
3. `runAllPending` must execute all pending tasks concurrently using `Promise.all` or equivalent
4. Task config parsing must validate input before processing
5. All status comparisons must use strict equality (`===`)
6. `findTask` return type must match its signature (no returning `undefined` from a non-optional return type)

## Architecture
- Module-level task store (in-memory dictionary)
- EventEmitter for lifecycle hooks (created, started, completed, failed)
- Pure functions where possible, mutations only in the store
