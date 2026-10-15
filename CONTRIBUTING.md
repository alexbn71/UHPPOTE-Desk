# Contributing to UHPPOTE Desk

Thanks for your interest! Bug reports, ideas, translations and code are all welcome.

## Questions, ideas and bugs

- **Questions and help** (installation, configuration, "how do I…"): open a topic in
  [Discussions](https://github.com/alexbn71/UHPPOTE-Desk/discussions), category *Q&A*.
- **Ideas** you would like to talk about first: Discussions, category *Ideas*.
- **Bugs**: open an [issue](https://github.com/alexbn71/UHPPOTE-Desk/issues/new/choose) with the *Bug report* form.
  The most useful details are the UHPPOTE Desk version (*System* page), how it is installed, the controller model and
  firmware, and the server log around the problem.
- **Feature requests**: an issue with the *Feature request* form, describing the problem you want to solve.

Before opening an issue, please search the existing ones and read the [user manual](docs/UHPPOTE-Desk-Manual.pdf)
and the [Docker guide](docs/DOCKER.md) (its troubleshooting section covers most network problems).

**Security problems** (e.g. a way to open doors or read data without permission): do not open a public issue; use
[private vulnerability reporting](https://github.com/alexbn71/UHPPOTE-Desk/security/advisories/new) instead.

## Development setup

Requirements: Node.js ≥ 22 (developed with Node 24). No real controller is needed: the repository includes a
simulator.

```bash
npm install
cp .env.example .env            # local configuration
npm run sim                     # terminal 1: simulated controller
npm run dev                     # terminal 2: server (http://localhost:8080) + web with hot reload (http://localhost:5173)
```

Repository layout, the commands and what each test suite covers are described in the [README](README.md#tests);
the protocol and the design decisions in [ANALYSIS.md](ANALYSIS.md).

## Pull requests

1. For anything bigger than a small fix, open an issue or a discussion first, so we can agree on the approach.
2. Create a branch from `main` and keep the pull request focused on one change.
3. Before pushing, run the same checks as the CI:

   ```bash
   npm run typecheck
   npm test
   npm run test:int
   npm run e2e                 # when you change the web interface
   ```

4. Add or update tests for what you change: unit tests for logic, integration tests for API and protocol, Playwright
   for user flows.
5. Update the documentation (README, `docs/`) when behaviour or configuration changes, and add a line to the
   *Unreleased* section of [CHANGELOG.md](CHANGELOG.md) (create it at the top if missing).

### Code style

- TypeScript everywhere; follow the style of the surrounding code (Prettier settings are in `.prettierrc.json`).
- Code, comments, logs and commit messages are in English.
- Every text shown to users goes through the translations in
  [packages/shared/src/i18n](packages/shared/src/i18n): add each new key to **all** the language files (`en`, `it`,
  `es`, `fr`, `de`); TypeScript and a unit test check that none is missing. If you cannot translate a language,
  use the English text and say so in the pull request.
- Errors returned by the server use a code (`errors.*`) with parameters, so the browser can translate them.

### Translations

Improvements to the existing languages and new languages are very welcome: see
[Languages](README.md#languages) in the README.

## License of contributions

UHPPOTE Desk is released under the [GNU Affero General Public License v3.0 or later](LICENSE) with the additional
terms in [ADDITIONAL-TERMS.md](ADDITIONAL-TERMS.md). By submitting a contribution you agree that it is distributed
under the same terms. The author credits shown in the application must not be removed or changed.

Do not add files from the controller manufacturer (software, manuals, firmware): they are not redistributable.
