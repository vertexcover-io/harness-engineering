# @acme/ui-kit

A React component library for Acme products.

## Installation

```bash
npm install @acme/ui-kit
```

## Components

### Button

```tsx
import { Button } from "@acme/ui-kit";

<Button variant="primary" onClick={handleClick}>
  Click me
</Button>
```

Props:
- `variant` — `"primary"` | `"secondary"` | `"ghost"`
- `size` — `"sm"` | `"md"` | `"lg"`
- `onClick` — Click handler
- `disabled` — Disable the button

### TextInput

```tsx
import { TextInput } from "@acme/ui-kit";

<TextInput label="Email" placeholder="you@example.com" onChange={handleChange} />
```

Props:
- `label` — Input label
- `placeholder` — Placeholder text
- `onChange` — Change handler
- `error` — Error message to display

### Modal

```tsx
import { Modal } from "@acme/ui-kit";

<Modal isOpen={isOpen} onClose={handleClose} title="Confirm">
  <p>Are you sure?</p>
</Modal>
```

## Theming

Wrap your app in `ThemeProvider`:

```tsx
import { ThemeProvider } from "@acme/ui-kit";

<ThemeProvider theme="light">
  <App />
</ThemeProvider>
```

Available themes: `"light"`, `"dark"`.
