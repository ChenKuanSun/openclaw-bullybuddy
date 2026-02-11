# Contributing to BullyBuddy

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/openclaw/bullybuddy.git
cd bullybuddy
npm install
npm run dev
```

## Running Tests

```bash
npm test           # Run once
npm run test:watch # Watch mode
npm run typecheck  # Type-check only
```

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes with clear commit messages
3. Add tests for new functionality
4. Ensure all tests pass (`npm test`)
5. Ensure no type errors (`npm run typecheck`)
6. Submit a PR with a clear description

## Code Style

- TypeScript strict mode
- No `any` types without justification
- Prefer functional patterns
- Keep functions focused and small

## Reporting Issues

- Check existing issues first
- Include reproduction steps
- Include environment info (Node version, OS)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
