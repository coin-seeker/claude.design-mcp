import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

// Chrome's reduced UA freezes the OS token per platform (macOS always reports 10_15_7, even on Apple silicon).
const OS_TOKENS = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};
const MODE_FILE = '.claude-design-chrome-mode';
const CHROME_MODES = new Set(['headless', 'offscreen', 'visible']);
const DISCONNECTED = /closed|disconnected|Target page, context or browser/i;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Headless is the default; CLAUDE_DESIGN_HEADLESS=0|false|off|no restores the off-screen window.
export function headlessEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.CLAUDE_DESIGN_HEADLESS ?? '').trim());
}

export function reducedUserAgent(major, platform = process.platform) {
  const os = OS_TOKENS[platform] ?? OS_TOKENS.linux;
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function plistMajor(bin, readFileImpl) {
  let plist;
  try {
    plist = await readFileImpl(join(dirname(bin), '..', 'Info.plist'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  return /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./.exec(plist)?.[1] ?? null;
}

// The macOS bundle plist is read first so no Chrome process is spawned; `--version` covers other layouts.
export async function chromeMajorVersion(bin, { readFileImpl = readFile, execFileImpl = promisify(execFile) } = {}) {
  const fromPlist = await plistMajor(bin, readFileImpl);
  if (fromPlist) return fromPlist;
  const { stdout } = await execFileImpl(bin, ['--version'], { timeout: 10_000 });
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(String(stdout))?.[1];
  if (!major) throw new Error(`Cannot read the Chrome version from ${bin}; set CLAUDE_DESIGN_USER_AGENT or CLAUDE_DESIGN_HEADLESS=0`);
  return major;
}

// Headless Chrome advertises "HeadlessChrome" in its UA; replace it with the headed UA of the same build.
export async function headlessUserAgent(bin, env = process.env, deps = {}) {
  const override = String(env.CLAUDE_DESIGN_USER_AGENT ?? '').trim();
  return override || reducedUserAgent(await chromeMajorVersion(bin, deps), deps.platform);
}

export async function readChromeMode(profile) {
  try {
    const mode = (await readFile(join(profile, MODE_FILE), 'utf8')).trim();
    return CHROME_MODES.has(mode) ? mode : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeChromeMode(profile, mode) {
  return writeFile(join(profile, MODE_FILE), `${mode}\n`);
}

// SingletonLock is a dangling symlink, so existence must be checked with lstat, not stat/existsSync.
async function profileLocked(profile) {
  try {
    await lstat(join(profile, 'SingletonLock'));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// Closes the browser and waits until both the CDP port and the profile lock are released, so a relaunch on the
// same profile cannot hand off to the exiting instance.
export async function closeChrome(browser, { isUp, profile, timeoutMs = 15_000 }) {
  const cdp = await browser.newBrowserCDPSession();
  try {
    await cdp.send('Browser.close');
  } catch (error) {
    if (!DISCONNECTED.test(String(error?.message ?? error))) throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isUp()) && !(await profileLocked(profile))) return;
    await delay(250);
  }
  throw new Error(`Chrome did not exit within ${timeoutMs}ms; ${join(profile, 'SingletonLock')} is still present`);
}
