# Contributing

Contributions are welcome.

## Development

Requirements:

- Node.js 24
- npm
- VS Code 1.137+ / VS Code Insiders

Install dependencies and run the tests:

```bash
npm ci
npm test
```

Build a VSIX before submitting changes that affect packaging:

```bash
npm run package
```

## Pull requests

Keep changes focused and include tests for protocol or behavior changes. Avoid adding provider-specific model catalogs when the same capability can be discovered from the upstream API.

Do not commit API keys, local endpoints, generated `out/` files, `node_modules/`, or VSIX packages.
