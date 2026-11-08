// OpenNext config for the Cloudflare Workers deploy target.
//
// Most of the defaults from defineCloudflareConfig() are correct for
// us — Next.js 16 App Router, Workers Node compat enabled, image
// optimization via Cloudflare's image-resizing service when available.
//
// We pin the override here so future @opennextjs/cloudflare upgrades
// can't silently change our deploy shape.

import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({});
