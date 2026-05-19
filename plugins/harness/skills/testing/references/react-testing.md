# React Testing Patterns

**Read this reference when:** testing React components, hooks, or context providers. For general testing principles (behavior over implementation, factories, mock discipline), the main SKILL.md applies — this file covers React-specific patterns only.

Uses **React Testing Library** (RTL). If you see Enzyme, `shallow()`, or `wrapper.state()` in the codebase, flag it — those patterns test implementation details.

---

## The Mental Model

React components are functions: **props in, rendered DOM out.** Test them the same way you test any function — provide inputs, assert on outputs. The "output" is what the user sees on screen, not internal state or lifecycle methods.

---

## Component Testing

### Basic Pattern

```tsx
it('should display user profile information', () => {
  render(<UserProfile name="Alice" email="alice@example.com" />);

  expect(screen.getByText(/alice/i)).toBeInTheDocument();
  expect(screen.getByText(/alice@example.com/i)).toBeInTheDocument();
});
```

### Testing User Interactions

```tsx
it('should submit the form with user input', async () => {
  const handleSubmit = vi.fn();
  const user = userEvent.setup();

  render(<LoginForm onSubmit={handleSubmit} />);

  await user.type(screen.getByLabelText(/email/i), 'test@example.com');
  await user.type(screen.getByLabelText(/password/i), 'secret');
  await user.click(screen.getByRole('button', { name: /submit/i }));

  expect(handleSubmit).toHaveBeenCalledWith({
    email: 'test@example.com',
    password: 'secret',
  });
});
```

Note: asserting that `handleSubmit` was called with specific arguments is testing **behavior** (the form collects and submits the right data), not implementation. The callback is part of the component's public API (its props).

### Testing Conditional Rendering

```tsx
it('should show error message when login fails', async () => {
  server.use(
    http.post('/api/login', () => {
      return HttpResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    })
  );

  const user = userEvent.setup();
  render(<LoginForm />);

  await user.type(screen.getByLabelText(/email/i), 'wrong@example.com');
  await user.click(screen.getByRole('button', { name: /submit/i }));

  await screen.findByText(/invalid credentials/i);
});
```

### Testing Loading and Async States

```tsx
it('should show loading indicator then data', async () => {
  render(<UserList />);

  expect(screen.getByText(/loading/i)).toBeInTheDocument();

  await screen.findByText(/alice/i);

  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
});
```

---

## Query Priority

RTL provides multiple query types. Use them in this order of preference:

1. **`getByRole`** — accessible role (button, heading, textbox). Best because it mirrors how assistive technology and users find elements.
2. **`getByLabelText`** — form inputs by their label. Tests accessibility for free.
3. **`getByPlaceholderText`** — when no label exists (flag this — inputs should have labels).
4. **`getByText`** — visible text content.
5. **`getByDisplayValue`** — current value of form elements.
6. **`getByTestId`** — last resort. If you need this, consider whether the component has accessibility gaps.

Avoid querying by class name, component name, or internal structure.

---

## Testing Hooks

### Custom Hooks with `renderHook`

Built into RTL since v13:

```tsx
import { renderHook, act } from '@testing-library/react';

it('should toggle boolean value', () => {
  const { result } = renderHook(() => useToggle(false));

  expect(result.current.value).toBe(false);

  act(() => {
    result.current.toggle();
  });

  expect(result.current.value).toBe(true);
});
```

### Hooks That Need Context

```tsx
const { result } = renderHook(() => useAuth(), {
  wrapper: ({ children }) => (
    <AuthProvider>{children}</AuthProvider>
  ),
});

expect(result.current.user).toBeNull();

act(() => {
  result.current.login({ email: 'test@example.com' });
});

expect(result.current.user).toEqual({ email: 'test@example.com' });
```

---

## Context and Providers

### Render Helper for Context

When multiple tests need the same providers, create a render helper:

```tsx
const renderWithProviders = (ui: React.ReactElement, options = {}) => {
  const { user = null, theme = 'light', ...renderOptions } = options;
  return render(
    <AuthProvider initialUser={user}>
      <ThemeProvider theme={theme}>
        {ui}
      </ThemeProvider>
    </AuthProvider>,
    renderOptions
  );
};

it('should show admin controls for admin users', () => {
  renderWithProviders(<Dashboard />, {
    user: { name: 'Alice', role: 'admin' },
  });

  expect(screen.getByRole('button', { name: /admin settings/i })).toBeInTheDocument();
});
```

---

## API Mocking with MSW

Use **Mock Service Worker** (MSW) to intercept network requests. MSW works at the network level, so your components make real fetch/axios calls — only the network response is faked.

```tsx
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.get('/api/users', () => {
    return HttpResponse.json([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it('should display list of users', async () => {
  render(<UserList />);
  await screen.findByText(/alice/i);
  expect(screen.getByText(/bob/i)).toBeInTheDocument();
});
```

Override handlers per test for error scenarios:

```tsx
it('should show error when API fails', async () => {
  server.use(
    http.get('/api/users', () => {
      return HttpResponse.json({ error: 'Server error' }, { status: 500 });
    })
  );

  render(<UserList />);
  await screen.findByText(/error/i);
});
```

---

## Component Test Factories

Apply the factory pattern from the main skill to component rendering:

```tsx
const renderUserProfile = (overrides = {}) => {
  const props = {
    name: 'Test User',
    email: 'test@example.com',
    role: 'user',
    onEdit: vi.fn(),
    ...overrides,
  };

  render(<UserProfile {...props} />);

  return {
    props,
    getEditButton: () => screen.getByRole('button', { name: /edit/i }),
  };
};

it('should show edit button for admin users', () => {
  const { getEditButton } = renderUserProfile({ role: 'admin' });
  expect(getEditButton()).toBeInTheDocument();
});
```

---

## React-Specific Anti-Patterns

### 1. Shallow Rendering

```tsx
// Bad: hides integration bugs between parent and child
const wrapper = shallow(<MyComponent />);

// Good: full render, test what users see
render(<MyComponent />);
```

Shallow rendering skips child components, so you miss bugs in how components work together. Always use full rendering.

### 2. Testing Internal State

```tsx
// Bad: testing implementation
const wrapper = mount(<Counter />);
expect(wrapper.state('count')).toBe(0);

// Good: testing behavior
render(<Counter />);
expect(screen.getByText(/count: 0/i)).toBeInTheDocument();
```

### 3. Unnecessary `act()` Wrapping

Modern RTL auto-wraps `render()`, `userEvent`, `fireEvent`, `waitFor`, and `findBy*` in `act()`. Manual `act()` is only needed for direct state updates in `renderHook`.

```tsx
// Bad: unnecessary act()
act(() => {
  render(<MyComponent />);
});

// Good: RTL handles it
render(<MyComponent />);
```

### 4. Manual `cleanup()` Calls

RTL auto-cleans after each test since v9. Remove manual cleanup.

```tsx
// Bad: unnecessary
afterEach(() => cleanup());

// Good: just remove it
```

### 5. Shared Render in `beforeEach`

```tsx
// Bad: shared mutable state
let button;
beforeEach(() => {
  render(<MyComponent />);
  button = screen.getByRole('button');
});

// Good: factory per test
const renderMyComponent = () => {
  render(<MyComponent />);
  return { button: screen.getByRole('button') };
};

it('test 1', () => {
  const { button } = renderMyComponent();
});
```

### 6. Snapshot Tests as Primary Strategy

Snapshot tests are fragile and rarely catch real bugs. They break on every cosmetic change and encourage "update snapshot" reflexes without review. Use them sparingly for stable, serializable output (like configuration objects), not as the primary way to test components.

---

## Testing Portals, Suspense, and Error Boundaries

RTL queries search the entire document, so portals work automatically:

```tsx
it('should render modal content', () => {
  render(<Modal isOpen={true}>Modal content</Modal>);
  expect(screen.getByText(/modal content/i)).toBeInTheDocument();
});
```

For Suspense:

```tsx
it('should show fallback then content', async () => {
  render(
    <Suspense fallback={<div>Loading...</div>}>
      <LazyComponent />
    </Suspense>
  );

  expect(screen.getByText(/loading/i)).toBeInTheDocument();
  await screen.findByText(/lazy content/i);
});
```

For Error Boundaries:

```tsx
it('should catch and display error', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

  render(
    <ErrorBoundary fallback={<div>Something went wrong</div>}>
      <ComponentThatThrows />
    </ErrorBoundary>
  );

  expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  spy.mockRestore();
});
```

---

## Form Testing

### Validation Feedback

```tsx
it('should show validation errors on empty submit', async () => {
  const user = userEvent.setup();
  render(<RegistrationForm />);

  await user.click(screen.getByRole('button', { name: /sign up/i }));

  expect(screen.getByText(/name is required/i)).toBeInTheDocument();
  expect(screen.getByText(/email is required/i)).toBeInTheDocument();
});
```

### Controlled Input Behavior

```tsx
it('should update search as user types', async () => {
  const user = userEvent.setup();
  render(<SearchInput />);

  const input = screen.getByLabelText(/search/i);
  await user.type(input, 'react');

  expect(input).toHaveValue('react');
});
```

---

## Checklist

React-specific checks (in addition to the main skill checklist):

- [ ] Using `render()` from `@testing-library/react`, not Enzyme
- [ ] Using `renderHook()` for custom hooks
- [ ] Using `wrapper` option for context providers
- [ ] Queries follow the priority: `getByRole` > `getByLabelText` > `getByText` > `getByTestId`
- [ ] No manual `act()` around RTL methods
- [ ] No manual `cleanup()` calls
- [ ] No shallow rendering
- [ ] No assertions on component state or instance methods
- [ ] Factory/render helper functions, not `beforeEach` render
- [ ] API mocking at the network level (MSW), not at the module level
