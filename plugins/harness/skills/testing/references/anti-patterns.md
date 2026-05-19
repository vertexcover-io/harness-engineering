# Testing Anti-Patterns

**Read this reference when:** writing or reviewing tests that involve mocks, adding test infrastructure, or when tests feel brittle or hard to maintain.

---

## The Bottom Line

**Mocks are tools to isolate, not things to test.** If you are asserting that a mock was called or that a mock element exists, you have stopped testing your code and started testing your test setup.

Strict TDD prevents most of these anti-patterns naturally, because writing the test first forces you to think about what behavior you are actually verifying.

---

## Anti-Pattern 1: Testing Mock Behavior

**What it looks like:**

```typescript
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

```python
def test_sends_notification(self):
    mock_notifier = Mock()
    service = OrderService(notifier=mock_notifier)
    service.place_order(order)
    mock_notifier.send.assert_called_once()  # Testing the mock, not the outcome
```

**Why it is wrong:** You are verifying that your test infrastructure works, not that your code works. The test passes when the mock is present and fails when it is removed — it tells you nothing about real behavior.

**The fix:** Test outcomes, not interactions.

```typescript
test('renders sidebar navigation', () => {
  render(<Page />);
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});
```

```python
def test_order_confirmation_is_sent(self):
    notifier = FakeNotifier()  # In-memory fake, not a mock
    service = OrderService(notifier=notifier)
    service.place_order(order)
    assert notifier.last_message.recipient == order.customer_email
    assert "confirmed" in notifier.last_message.subject
```

**Gate question before asserting on any mock:** "Am I testing real behavior or just mock existence?"

---

## Anti-Pattern 2: Test-Only Methods in Production Code

**What it looks like:**

```typescript
class Session {
  async destroy() {
    // Only called in tests for cleanup
    await this._workspaceManager?.destroyWorkspace(this.id);
  }
}

// In tests
afterEach(() => session.destroy());
```

```python
class PaymentGateway:
    def _reset_for_testing(self):
        """Only used in tests."""
        self._transactions = []
```

**Why it is wrong:** Production code should serve production needs. Test-only methods pollute the interface, risk accidental production use, and blur the boundary between what the code does and what the tests need.

**The fix:** Move test cleanup and utilities to test helpers.

```typescript
// test-utils/session-helpers.ts
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}
```

**Gate question before adding a method:** "Is this only used by tests? Then it belongs in test utilities, not production code."

---

## Anti-Pattern 3: Mocking Without Understanding

**What it looks like:**

```typescript
test('detects duplicate server', () => {
  // Mock prevents config write that test depends on
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config); // Should throw — but won't
});
```

```python
def test_retries_on_failure(self):
    # Mock removes the retry delay... and also the retry logic
    with patch("time.sleep"):
        with patch.object(client, "send", side_effect=ConnectionError):
            client.send_with_retry(message)
            # Test passes but does not test retry behavior at all
```

**Why it is wrong:** The mock removed a side effect that the test depended on. This happens when you mock "to be safe" without understanding what the real implementation does.

**The fix:** Understand the dependency chain before mocking. Run the test with real implementations first to see what actually needs to happen.

```typescript
test('detects duplicate server', () => {
  vi.mock('MCPServerManager'); // Mock only the slow part
  await addServer(config);     // Config write happens
  await addServer(config);     // Duplicate detected
});
```

**Gate questions before mocking:**
1. What side effects does the real method have?
2. Does this test depend on any of those side effects?
3. Can I mock at a lower level to preserve the behavior I need?

**Red flags:** "I'll mock this to be safe." "This might be slow, better mock it." Mocking without understanding the dependency chain.

---

## Anti-Pattern 4: Incomplete Mocks

**What it looks like:**

```typescript
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // Missing: metadata that downstream code accesses
};
```

```python
mock_response = {
    "results": [{"id": 1, "name": "Item"}]
    # Missing: pagination, total_count, next_page
}
```

**Why it is wrong:** Partial mocks hide structural assumptions. Tests pass because they only exercise the fields you included. Downstream code that accesses missing fields fails silently or with confusing errors in production.

**The fix:** Mock the complete data structure. Check the real API response or schema documentation.

```typescript
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
};
```

**Gate question:** "Does this mock include every field the real response contains?"

---

## Anti-Pattern 5: Writing Tests After Implementation

**What it looks like:**

```
1. Write all production code
2. "Now let's add tests"
3. Tests written to match existing code (not to verify behavior)
```

**Why it is wrong:** Tests written after the fact tend to mirror the implementation rather than describe the intended behavior. They cement bugs instead of catching them. They are also more likely to be skipped or written superficially because the "real work" feels done.

**The fix:** Write the test first. Watch it fail. Then implement.

The failure step is important — it proves your test actually checks something. A test that passes immediately might not be testing what you think.

---

## Anti-Pattern 6: Over-Complex Mock Setup

**Warning signs:**
- Mock setup is longer than the test itself
- You need to mock 5+ things to test one function
- Mocks require `.mockReturnValueOnce()` chains for sequencing
- Removing a mock breaks the test in unexpected ways

**What this really means:** The code under test has too many dependencies. The complexity in the test setup reflects complexity in the production code.

**The fix:** This is a testability problem, not a testing problem. Suggest refactoring:
- Extract pure logic from side-effectful code
- Reduce the number of direct dependencies
- Introduce interfaces at natural boundaries
- Consider whether an integration test (fewer mocks, more real code) is more appropriate

---

## Quick Reference

| Anti-Pattern | Fix |
|---|---|
| Assert on mock elements | Test real behavior or unmock it |
| Test-only methods in production | Move to test utilities |
| Mock without understanding | Understand dependencies first, mock minimally |
| Incomplete mocks | Mirror real data structures completely |
| Tests after implementation | TDD — write the test first |
| Over-complex mock setup | Refactor the production code for testability |

## Red Flags Checklist

- [ ] Assertion checks for `*-mock` test IDs
- [ ] Methods only called in test files exist in production code
- [ ] Mock setup is more than a third of the test
- [ ] Test fails when you remove a mock (but shouldn't)
- [ ] Can't explain why a specific mock is needed
- [ ] Mocking "just to be safe"
- [ ] `.toHaveBeenCalled()` without checking outcomes
- [ ] More than 3 mocks in a single test
