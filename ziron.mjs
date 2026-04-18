#!/usr/bin/env node

/**
 * Ziron CLI Entrypoint
 * Minimal bootstrap with Node version check
 */

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 0;

function parseNodeVersion(rawVersion) {
  const [majorRaw = "0", minorRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
  };
}

function isSupportedNodeVersion(version) {
  return (
    version.major > MIN_NODE_MAJOR ||
    (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR)
  );
}

function ensureSupportedNodeVersion() {
  const current = parseNodeVersion(process.versions.node);
  if (isSupportedNodeVersion(current)) {
    return;
  }

  console.error(
    `ziron: Node.js v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ required (current: v${process.versions.node})\n` +
    "If you use nvm, run:\n" +
    `  nvm install ${MIN_NODE_MAJOR}\n` +
    `  nvm use ${MIN_NODE_MAJOR}\n` +
    `  nvm alias default ${MIN_NODE_MAJOR}`
  );
  process.exit(1);
}

ensureSupportedNodeVersion();

// Load main entry
import('./src/index.js').catch(err => {
  console.error('Failed to load ziron:', err.message);
  process.exit(1);
});
