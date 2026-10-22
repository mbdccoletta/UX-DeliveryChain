/**
 * Copy the manifest's version into the one constant the UI prints.
 *
 * The screen has to say which build it is — several rounds of debugging were
 * spent on code that was not the code on the reader's screen. But a constant
 * typed by hand drifts from the manifest the first time someone bumps one and
 * forgets the other, and a version stamp that lies is worse than none. So the
 * build writes it: npm's `prebuild` hook runs this before every `dt-app
 * build`, and the value can only come from app.config.json.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("app.config.json", "utf8")).app.version;
const path = "ui/app/components/Pulse.tsx";
const src = readFileSync(path, "utf8");
const re = /export const APP_VERSION = "[^"]*";/;

if (!re.test(src)) {
  console.error(`stamp-version: APP_VERSION not found in ${path}`);
  process.exit(1);
}
const next = src.replace(re, `export const APP_VERSION = "${version}";`);
if (next !== src) {
  writeFileSync(path, next);
  console.log(`stamp-version: ${version}`);
}
