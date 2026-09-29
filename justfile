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

# Check the upload and bindings without publishing.
deploy-dry-run:
    pnpm exec cf deploy --dry-run

check: typecheck build deploy-dry-run
