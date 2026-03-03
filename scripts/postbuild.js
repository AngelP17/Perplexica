#!/usr/bin/env node

/**
 * Post-build script to copy runtime assets to standalone output
 * This ensures the standalone server has access to:
 * - drizzle/ (database migrations)
 * - data/ (database and workspace directories)
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const standaloneDir = path.join(rootDir, '.next', 'standalone');

console.log('[postbuild] Copying runtime assets to standalone output...');

// Copy drizzle directory
const drizzleSource = path.join(rootDir, 'drizzle');
const drizzleTarget = path.join(standaloneDir, 'drizzle');

if (fs.existsSync(drizzleSource)) {
  // Remove target if exists
  if (fs.existsSync(drizzleTarget)) {
    fs.rmSync(drizzleTarget, { recursive: true, force: true });
  }

  // Copy recursively
  fs.cpSync(drizzleSource, drizzleTarget, { recursive: true });
  console.log('[postbuild] ✓ Copied drizzle/ to standalone output');
} else {
  console.warn('[postbuild] ⚠ drizzle/ directory not found, skipping');
}

// Ensure data directory exists
const dataTarget = path.join(standaloneDir, 'data');
if (!fs.existsSync(dataTarget)) {
  fs.mkdirSync(dataTarget, { recursive: true });
  console.log('[postbuild] ✓ Created data/ directory in standalone output');
}

// Copy existing data if present (for local dev)
const dataSource = path.join(rootDir, 'data');
if (fs.existsSync(dataSource)) {
  fs.cpSync(dataSource, dataTarget, { recursive: true });
  console.log('[postbuild] ✓ Copied existing data/ to standalone output');
}

console.log('[postbuild] Runtime assets ready for standalone execution');
console.log('[postbuild] You can now run: node .next/standalone/server.js');
