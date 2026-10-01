default:
    @just --list

explainer_skill := env_var_or_default("EXPLAINER_SKILL", env_var("HOME") + "/.agents/skills/explainer")

# Install the dependencies from the lockfile.
install:
    pnpm install --frozen-lockfile

# Type-check the Worker and its Cloudflare bindings.
typecheck:
    pnpm run typecheck

# Build the Worker locally.
build:
    pnpm run build

# Start the local Cloudflare development server.
dev:
    pnpm run dev

# Test the frontend and Worker API through one dev server.
test *args:
    pnpm run test:e2e {{args}}

# Verify all Quint models, or selected modules (for example: just model-check k2).
model-check *models:
    node scripts/check-model.mjs {{models}}

# Check links in the consolidated guide and its standalone HTML copy.
docs-check:
    node scripts/check-guide-links.mjs

# Verify the Queues/K2 illustrated guide with mizchi/explainer; start just dev first.
explain-check:
    node "{{explainer_skill}}/scripts/verify-doc.mjs" docs/queues-vs-k2

# Check the upload and bindings without publishing.
deploy-dry-run:
    pnpm exec cf deploy --dry-run

check: typecheck build deploy-dry-run test model-check docs-check
