# Test Granularity: Integration and E2E Testing

**Read this reference when:** the analysis step in the main skill identified that integration or e2e tests are needed, or when reviewing a test suite's overall balance.

This file covers **how to write good integration and e2e tests** — the principles, patterns, and the analyze-test cycle that applies to each level.

---

## The Analyze-Test Cycle

Writing integration and e2e tests follows the same behavioral testing principles as unit tests, but adds an analysis phase to handle the additional complexity of real infrastructure and multi-component interactions.

### The Cycle

```
1. ANALYZE  →  2. DESIGN  →  3. WRITE  →  4. VERIFY  →  5. HARDEN
    ↑                                                         |
    └─────────────────────────────────────────────────────────┘
```

**1. Analyze** — Map the boundaries. Before writing a single test, trace the code path and identify:
- What external systems does it touch? (database, APIs, filesystem, queues, caches)
- What are the failure modes at each boundary? (network errors, timeouts, constraint violations, stale data)
- What is the contract at each boundary? (request/response shapes, status codes, error formats)
- Which boundaries can use real implementations? Which need fakes?

**2. Design** — For each boundary, present the user with the isolation options and let them choose:
- **Use real:** in-memory databases, embedded servers, Testcontainers, or the actual service (e.g., a local dev server, staging API)
- **Use fakes:** in-memory implementations that preserve behavior (e.g., a fake repository that stores in a dict/map)
- **Use stubs at the network level:** MSW, WireMock, or similar HTTP-level interception (not module-level mocking)

The choice depends on the user's context — they may have a local instance running, a sandbox environment, or prefer to hit the real service for confidence. Ask before assuming.

**3. Write** — Write the test following the same Arrange-Act-Assert pattern as unit tests. One behavior per test. Descriptive name.

**4. Verify** — Run the test. Check:
- Does it fail for the right reason when the behavior is broken? (Introduce a deliberate bug and confirm the test catches it.)
- Does it pass deterministically? Run it 3 times. If it fails intermittently, fix the flakiness before moving on.
- Is the failure message useful? When it fails, can you tell what went wrong without reading the test source?

**5. Harden** — After the test passes reliably:
- Add error/failure path tests for the same boundary (timeout, invalid response, connection refused)
- Check test isolation — does it leave behind state that could affect other tests?
- Verify cleanup — database rows, temp files, background processes should be cleaned up

Then loop back: analyze the next boundary or the next behavior at the same boundary.

---

## Writing Good Integration Tests

### What Makes It an Integration Test

An integration test exercises **real interactions between your code and its dependencies** — databases, file systems, other modules through their real implementations. If every dependency is mocked, it is a unit test regardless of how many modules it touches.

### Principles

**1. Use real dependencies wherever practical.**

The point of an integration test is to catch bugs that live *between* components. Mocking the database in an integration test defeats the purpose entirely — you are testing your assumptions about the database, not the database.

Modern tooling has made this cheap:
- **In-memory databases:** SQLite (`:memory:`), H2 for Java, or test-specific Postgres/MySQL via Testcontainers
- **Embedded services:** Redis in test mode, LocalStack for AWS services, MinIO for S3
- **Testcontainers:** Spin up real Docker containers (Postgres, Redis, Kafka) for the test run, tear them down after

**2. Ask the user how to handle external services.**

For services outside your codebase (third-party APIs, payment processors, partner services), there are multiple valid strategies. Present them to the user and let them choose:

- **Hit the real service** — if a sandbox/staging environment exists and is fast and reliable, this gives the highest confidence. Good for: payment processor test modes, local dev servers, services with official test environments.
- **Fake at the network level** — intercept HTTP calls and return controlled responses. Your code still executes the full request path (serialization, headers, error handling), which is more realistic than module-level mocking. Tools: MSW, WireMock, `responses` (Python), `nock` (Node), `httptest` (Go).
- **Use a local substitute** — run a local version of the service (LocalStack for AWS, MinIO for S3, a Docker image of the service). Good for services you need to test write behavior against.

Example conversation:
> "This code calls the Stripe API for payment processing. We have a few options for testing: (1) use Stripe's test mode with test API keys — highest confidence but requires network access, (2) fake the HTTP calls with MSW/WireMock — fast, deterministic, no network needed, (3) if there's an existing mock/stub pattern in the codebase, we can follow that. Which approach fits your setup?"

Whatever the strategy, avoid module-level mocking (e.g., `jest.mock('stripe')`) — it skips the HTTP layer entirely and hides serialization bugs, header issues, and error handling problems.

**3. Each test gets a clean slate.**

Integration tests that share state are a time bomb. Strategies:
- **Transaction rollback:** Wrap each test in a transaction, roll back after. Fast but does not test commit behavior.
- **Truncate tables:** Clear all tables before each test. Slower but tests real commit/read behavior.
- **Unique data per test:** Generate unique IDs and names per test. Tests can run in parallel without conflicts. Combine with periodic cleanup.

**4. Test failure modes, not just happy paths.**

The most dangerous bugs at integration boundaries are in error handling. For every integration point, test:
- What happens when the dependency is unreachable? (connection refused, timeout)
- What happens when it returns an error? (4xx, 5xx, constraint violation)
- What happens with malformed responses? (missing fields, wrong types)
- What happens under concurrent access? (race conditions, deadlocks)

**5. Keep each test focused on one integration point.**

A test that inserts into the database AND calls an external API AND writes to a file is testing three things. When it fails, you do not know which boundary broke. Write separate tests for each interaction.

### Integration Test Structure

```python
# Example: Testing that order creation persists correctly

def test_created_order_is_retrievable(db_session):
    # Arrange: set up preconditions using real database
    user = insert_user(db_session, make_user())
    product = insert_product(db_session, make_product(stock=10))

    # Act: exercise the real code path including database writes
    order = order_service.create_order(
        db=db_session,
        user_id=user.id,
        items=[{"product_id": product.id, "quantity": 2}],
    )

    # Assert: verify by reading back from the real database
    saved = order_repo.get_by_id(db_session, order.id)
    assert saved.user_id == user.id
    assert saved.total == product.price * 2
    assert saved.items[0].quantity == 2


def test_order_creation_fails_on_insufficient_stock(db_session):
    user = insert_user(db_session, make_user())
    product = insert_product(db_session, make_product(stock=1))

    with pytest.raises(InsufficientStockError):
        order_service.create_order(
            db=db_session,
            user_id=user.id,
            items=[{"product_id": product.id, "quantity": 5}],
        )

    # Verify no order was created (transaction rolled back)
    assert order_repo.count(db_session) == 0
```

### Integration Test Anti-Patterns

| Anti-Pattern | Why It's Wrong | Fix |
|---|---|---|
| Mocking the database | Defeats the purpose — you are testing your mock, not the query | Use a real or in-memory database |
| Shared test data across tests | Tests become order-dependent and fail randomly | Each test inserts its own data and cleans up |
| Testing only the happy path | Misses the most dangerous bugs at boundaries | Test error responses, timeouts, constraint violations |
| Enormous multi-step scenarios | Failure messages are useless — which step broke? | One integration point per test |
| No cleanup between tests | Data leaks cause cascading failures | Use transaction rollback, truncation, or unique data |
| Asserting on internal calls | "Did it call `db.save`?" is implementation, not behavior | Assert on observable state: what was persisted? what was returned? |

---

## Writing Good E2E Tests

### What Makes It an E2E Test

An e2e test exercises **a complete user journey through the full deployed system** — browser or API client talking to a real running application, hitting real databases and services. The system is in the same configuration as production (or as close as possible).

### Principles

**1. Test critical user journeys, not features.**

An e2e test should map to something a user actually does end-to-end: "sign up and complete first purchase," "create a project and invite a team member," "submit a report and verify it appears in the dashboard." These are the flows whose failure costs the most.

Start with 5-10 journeys. Resist the temptation to cover every feature with e2e tests.

**2. One journey per test.**

Do not chain unrelated workflows into a single test. If the checkout test also verifies the search feature and the account settings page, a failure in any of those three sections gives you a useless error message.

**3. Use accessible locators.**

Locate elements the way a user or screen reader would — by role, label, text, or placeholder. These survive UI refactoring. CSS selectors, class names, and `nth-child` paths break on every style change.

```
// Bad: brittle locators
page.locator('.btn-primary > span:nth-child(2)')
page.locator('#submit-btn-v2')

// Good: accessible locators
page.getByRole('button', { name: 'Place Order' })
page.getByLabel('Email address')
page.getByText('Order confirmed')
```

**4. Use smart waits, never hard-coded delays.**

`sleep(3000)` either waits too long (slow suite) or not long enough (flaky test). Wait for a specific condition:

```python
# Bad
time.sleep(5)
assert page.locator(".result").is_visible()

# Good
expect(page.get_by_text("Order confirmed")).to_be_visible(timeout=10_000)
```

**5. Capture failure artifacts.**

When an e2e test fails, you need:
- **Screenshot** at the moment of failure
- **Video** of the full test run (most frameworks support this)
- **Browser console logs** for JavaScript errors
- **Network trace** for failed API calls

Without these, debugging e2e failures becomes guesswork and developers stop investigating.

**6. Isolate test state.**

Each e2e test should start from a known state:
- **Authentication:** Use stored session state (cookies/tokens from a setup step), not a full login flow in every test
- **Data:** Seed test-specific data via API or database before each test, clean up after
- **Browser context:** Use fresh browser contexts per test to prevent cookie/storage leakage

### E2E Test Structure

```python
# Example: Playwright e2e test for checkout flow

def test_user_can_complete_checkout(page, authenticated_user, seeded_products):
    # Navigate to the product page
    page.goto("/products")
    page.get_by_role("link", name="Wireless Headphones").click()

    # Add to cart
    page.get_by_role("button", name="Add to Cart").click()
    expect(page.get_by_text("Added to cart")).to_be_visible()

    # Go to checkout
    page.get_by_role("link", name="Cart").click()
    page.get_by_role("button", name="Checkout").click()

    # Fill payment (using test card)
    page.get_by_label("Card number").fill("4242424242424242")
    page.get_by_label("Expiry").fill("12/30")
    page.get_by_label("CVC").fill("123")

    # Place order
    page.get_by_role("button", name="Place Order").click()

    # Verify confirmation
    expect(page.get_by_text("Order confirmed")).to_be_visible()
    expect(page.get_by_text("Wireless Headphones")).to_be_visible()
```

### The E2E Analyze-Test Cycle

E2e tests need a more careful analysis phase because failures are expensive to debug:

**Before writing:**
1. **Map the journey** — list every step the user takes, every page transition, every API call
2. **Identify flakiness risks** — animations, lazy loading, third-party scripts, network variability
3. **Plan data setup** — what state must exist before the test starts? How will you create it? How will you clean it up?
4. **Plan authentication** — how will the test get past login without repeating the login flow every time?

**After writing:**
1. **Run 5 times locally** — if it fails even once, fix the flakiness before committing
2. **Run in CI** — environment differences often reveal real flakiness (different timing, screen size, network)
3. **Break it intentionally** — remove a UI element or break an API endpoint and confirm the test fails with a useful message
4. **Check artifacts** — does the screenshot show the right moment? Does the video tell you what happened?

### E2E Anti-Patterns

| Anti-Pattern | Why It's Wrong | Fix |
|---|---|---|
| E2e tests for everything | Slow, flaky, expensive to maintain | Reserve for critical user journeys only |
| Testing business logic via e2e | 12 code paths = 12 slow e2e tests when 12 fast unit tests suffice | Push logic tests down to unit level |
| Chaining unrelated workflows | Failures are uninformative | One journey per test |
| Brittle CSS selectors | Break on every style change | Use role, label, text locators |
| `sleep()` / hard-coded waits | Either too slow or flaky | Wait for specific conditions |
| Full login in every test | Wastes time, adds flakiness | Store auth state, reuse across tests |
| No failure artifacts | Can't debug failures | Capture screenshots, video, console, network |
| Shared database state | Tests interfere with each other | Seed and clean up per test |

---

## Choosing the Right Test Level

### Decision Heuristic

Ask these questions in order:

1. **Can static analysis catch this?** → Not a test — configure your linter/type checker.
2. **Is this pure logic with clear inputs and outputs?** → Unit test.
3. **Does the behavior depend on a real database, filesystem, or cross-module interaction?** → Integration test.
4. **Does this cross a network boundary between independently deployed services?** → Contract test + integration test on each side.
5. **Is this a critical user journey through the full deployed system?** → E2e test.
6. **Has this bug escaped to production despite passing lower-level tests?** → Regression test at the lowest level that reproduces it.

**Push every test to the lowest level that provides the confidence you need.** Higher-level tests cost more to write, run, and maintain.

### Architecture-Driven Test Distribution

There is no universal ratio. The right shape depends on where your complexity lives:

| System Type | Where Complexity Lives | Emphasis |
|-------------|----------------------|----------|
| Algorithm library | Pure logic, many input combinations | Unit-heavy |
| Frontend application | Component interactions, user flows | Integration-heavy |
| Microservices / API-first | Service boundaries, network contracts | Integration-heavy + contract tests |
| Full-stack monolith | Mix of logic and integration | Balanced |

### Sociable vs. Solitary Tests

Tests exist on a spectrum from fully solitary (every collaborator mocked) to fully sociable (nothing mocked except process-external dependencies):

| | Sociable | Solitary |
|---|---|---|
| Refactoring resilience | High | Low |
| Fault isolation | Lower | High |
| Mock maintenance | Low | High |

**Practical default:** Use sociable tests. Only introduce mocks at awkward boundaries (network, time, randomness, expensive resources). If you need many mocks, that is design feedback — the code may have too many dependencies.

---

## Testing Health Metrics

| Metric | Target | What It Measures |
|--------|--------|-----------------|
| Bugs that create new tests | 100% | Every production bug produces a regression test |
| Tests that verify behavior | 100% | Outcomes, not implementation details |
| Tests that are deterministic | 100% | No flaky tests |
| Integration test suite time | < 5 min | Parallelization keeps feedback fast |
| E2e test suite time | < 15 min | Small suite, parallelized |

---

## Further Reading

- **Testing models compared:** [web.dev — Pyramid or Crab?](https://web.dev/articles/ta-strategies)
- **Anti-patterns catalog:** [Codepipes — Software Testing Anti-patterns](https://blog.codepipes.com/testing/software-testing-antipatterns.html)
- **Sociable vs. solitary:** [Martin Fowler — UnitTest](https://martinfowler.com/bliki/UnitTest.html)
- **Trophy model:** [Kent C. Dodds — The Testing Trophy](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications)
- **Microservices testing:** [Spotify — Testing of Microservices](https://engineering.atspotify.com/2018/01/testing-of-microservices)
- **Contract testing:** [Pact Documentation](https://docs.pact.io/)
