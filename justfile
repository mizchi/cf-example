default:
    @just --list

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
test:
    pnpm run test:e2e

# Verify naive counterexamples and repaired Quint models with TLC.
model-check:
    node scripts/check-model.mjs

# Check links in the consolidated guide and its standalone HTML copy.
docs-check:
    node scripts/check-guide-links.mjs

# Check the upload and bindings without publishing.
deploy-dry-run:
    pnpm exec cf deploy --dry-run

check: typecheck build deploy-dry-run test model-check docs-check
